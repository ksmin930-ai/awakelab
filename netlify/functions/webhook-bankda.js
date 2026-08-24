const { sendNotification } = require('./notify-helper');

// PostgreSQL tstzrange (UTC) -> KST(한국 표준시) 날짜 및 시간 문자열 변환
function parsePeriodToKST(periodStr) {
  if (!periodStr) return { dateStr: '', timeStr: '' };
  const clean = periodStr.replace(/[\[\)"']/g, '');
  const parts = clean.split(',').map(s => s.trim());
  if (parts.length < 2) return { dateStr: '', timeStr: '' };

  const startRaw = parts[0].replace(' ', 'T');
  const endRaw = parts[1].replace(' ', 'T');

  const startDate = new Date(startRaw);
  const endDate = new Date(endRaw);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return { dateStr: '', timeStr: '' };
  }

  const kstOffsetMs = 9 * 60 * 60 * 1000;
  const startKst = new Date(startDate.getTime() + kstOffsetMs);
  const endKst = new Date(endDate.getTime() + kstOffsetMs);

  const y = startKst.getUTCFullYear();
  const m = String(startKst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(startKst.getUTCDate()).padStart(2, '0');
  const dateStr = `${y}-${m}-${d}`;

  const startHour = String(startKst.getUTCHours()).padStart(2, '0');
  const startMin = String(startKst.getUTCMinutes()).padStart(2, '0');
  const endHour = String(endKst.getUTCHours()).padStart(2, '0');
  const endMin = String(endKst.getUTCMinutes()).padStart(2, '0');
  const timeStr = `${startHour}:${startMin}~${endHour}:${endMin}`;

  return { dateStr, timeStr };
}

// 텍스트 정규화 (공백, 특수문자 제거)
function normalizeText(text) {
  return (text || '').replace(/[\s\[\]\(\)\-_]/g, '').toLowerCase();
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Bankda-Secret',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase 환경 변수가 설정되지 않았습니다.');
    }

    // 뱅크다 웹훅 시크릿 검증 (설정되어 있을 때)
    const bankdaSecret = process.env.BANKDA_WEBHOOK_SECRET;
    const incomingSecret = event.headers['x-bankda-secret'] || event.headers['X-Bankda-Secret'];
    if (bankdaSecret && incomingSecret !== bankdaSecret) {
      console.warn('Bankda Webhook Secret 불일치');
      return { statusCode: 401, headers, body: JSON.stringify({ error: '웹훅 인증 실패' }) };
    }

    // 뱅크다 페이로드 파싱 (JSON 또는 x-www-form-urlencoded 지원)
    let payload = {};
    try {
      payload = JSON.parse(event.body);
    } catch(e) {
      const params = new URLSearchParams(event.body);
      payload = Object.fromEntries(params.entries());
    }

    // 뱅크다 주요 필드: deposit_name(입금자명), deposit_money(입금액), tx_id(거래번호), account_num(계좌번호)
    const depositName = (payload.deposit_name || payload.remitter || payload.remark || '').trim();
    const depositMoney = parseInt(String(payload.deposit_money || payload.amount || '0').replace(/[^0-9]/g, ''), 10);
    const txId = payload.tx_id || payload.transaction_id || `TX-${Date.now()}`;

    if (!depositName || !depositMoney) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '입금자명 또는 입금액 정보가 누락되었습니다.' }) };
    }

    console.log(`[Bankda Webhook 수신] 입금자명: ${depositName}, 금액: ${depositMoney.toLocaleString()}원, TX: ${txId}`);

    // 1. 현재 'pending' 상태인 모든 예약 조회
    const fetchResp = await fetch(`${supabaseUrl}/rest/v1/reservations?select=*&status=eq.pending&order=created_at.asc`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    if (!fetchResp.ok) throw new Error('DB 조회 실패');
    const pendingList = await fetchResp.json();

    if (!pendingList || pendingList.length === 0) {
      console.log('대기 중인(pending) 예약이 없습니다.');
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, matched: false, reason: 'NO_PENDING_RESERVATIONS' }) };
    }

    // 2. 입금 매칭 엔진 (금액 일치 + 입금자명 유사도 검사)
    const normDeposit = normalizeText(depositName);
    let matchedReservation = null;

    // 1차 매칭: 금액이 정확히 일치하는 후보군 탐색
    const amountCandidates = pendingList.filter(r => r.amount === depositMoney);

    if (amountCandidates.length === 1) {
      // 금액이 일치하는 후보가 정확히 1건인 경우 즉시 매칭
      matchedReservation = amountCandidates[0];
    } else if (amountCandidates.length > 1) {
      // 금액 일치 후보가 2건 이상인 경우 입금자명으로 정밀 판별
      for (const cand of amountCandidates) {
        const normBooker = normalizeText(cand.booker_name);
        if (normDeposit.includes(normBooker) || normBooker.includes(normDeposit)) {
          matchedReservation = cand;
          break;
        }
      }
      if (!matchedReservation) matchedReservation = amountCandidates[0]; // 최선 후보
    } else {
      // 정기권 분할 금액 또는 입금자명만으로 매칭 시도
      for (const r of pendingList) {
        const normBooker = normalizeText(r.booker_name);
        if (normDeposit.includes(normBooker) || normBooker.includes(normDeposit)) {
          matchedReservation = r;
          break;
        }
      }
    }

    if (!matchedReservation) {
      console.log(`매칭되는 예약을 찾지 못함 (입금자: ${depositName}, 금액: ${depositMoney})`);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, matched: false, reason: 'NO_MATCH_FOUND' }) };
    }

    console.log(`[매칭 성공!] 예약번호: ${matchedReservation.reservation_no}, 팀명: ${matchedReservation.booker_name}`);

    // 3. 매칭된 예약 확정(confirmed) 상태로 DB UPDATE
    let patchUrl = '';
    const resNo = matchedReservation.reservation_no;
    const isBatch = resNo && (resNo.startsWith('PASS-') || resNo.startsWith('FIXED-'));

    if (isBatch) {
      // 정기권/고정팀인 경우 해당 배치 번호 전체 일괄 확정
      const batchPrefix = resNo.includes('-W') ? resNo.split('-W')[0] + '%' : resNo;
      patchUrl = `${supabaseUrl}/rest/v1/reservations?reservation_no=like.${encodeURIComponent(batchPrefix)}`;
    } else {
      patchUrl = `${supabaseUrl}/rest/v1/reservations?id=eq.${matchedReservation.id}`;
    }

    const updateResp = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ status: 'confirmed' })
    });

    if (!updateResp.ok) throw new Error('DB 상태 업데이트 실패');

    // 4. 고객에게 카카오톡 알림톡 / 문자 (SMS) 즉시 자동 발송!
    const { dateStr, timeStr } = parsePeriodToKST(matchedReservation.period);
    const bookerPhone = matchedReservation.booker_phone;
    const teamName = matchedReservation.booker_name || '고객님';

    const confirmMessage = `안녕하세요! 당신의 사운드가 완성되는 특별한 공간, 어웨이크 랩(AWAKE LAB)입니다. 🎸

입금이 확인되어 예약이 최종 확정되었습니다. 방문 전 아래 출입 방법 및 안내 사항을 반드시 확인해 주세요!

■ 예약 정보
• 예약 일시: ${dateStr} (${timeStr})
• 예약자명: ${teamName} 님

■ 📍 오시는 길
경기 용인시 수지구 죽전로168번길 19 지하 1층 (고수찜닭 건물 B1)

■ 🔑 출입 안내 (★필독)
1. 건물 현관 출입구 비밀번호
👉 1236580*
(초입 현관문을 여실 때 사용해 주세요.)

2. 합주실 메인 도어 개방 (원격)
👉 010-6240-6569
합주실 문 앞 도착 후 위 번호로 '문자'를 남겨주시면 관리자가 확인 즉시 원격으로 문을 열어드립니다!

■ 💡 이용 시 주의사항
• 쾌적한 환경을 위해 비치된 실내화 착용을 부탁드립니다. (외부 신발 불가)
• 기기 보호를 위해 음식물 반입은 불가하며, 뚜껑 있는 음료만 반입 가능합니다.
• 다음 예약 팀을 위해 퇴실 5분 전 장비 전원 OFF 및 정리 정돈을 부탁드립니다.

어웨이크 랩에서 즐거운 추억 가득 남기시고, 여러분만의 멋진 사운드를 마음껏 완성하시길 바랍니다! 이용 중 궁금하신 점이 있다면 언제든 편하게 연락 주세요. 감사합니다! 🎶✨`;

    const confirmKakaoTemplate = process.env.KAKAO_CONFIRM_TEMPLATE_CODE; // 카카오 알림톡 템플릿 코드

    try {
      await sendNotification({
        to: bookerPhone,
        text: confirmMessage,
        title: '[AWAKE LAB] 예약 확정 안내',
        templateCode: confirmKakaoTemplate
      });
      console.log(`[확정 알림톡/문자 발송 성공] 수신자: ${bookerPhone}`);
    } catch(err) {
      console.error('알림 발송 실패:', err);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        matched: true,
        reservation_id: matchedReservation.id,
        reservation_no: matchedReservation.reservation_no,
        team_name: matchedReservation.booker_name,
        phone: matchedReservation.booker_phone,
        status: 'confirmed'
      })
    };

  } catch(error) {
    console.error('Bankda Webhook Handler Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message || '웹훅 처리 실패' }) };
  }
};
