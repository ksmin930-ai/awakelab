const { sendNotification } = require('./notify-helper');

// PostgreSQL tstzrange (UTC) -> KST(한국 표준시) 날짜 및 시간 문자열 변환
function parsePeriodToKST(periodStr) {
  if (!periodStr) return { date: '', times: [], dateStr: '', timeStr: '' };
  
  const dateTimes = periodStr.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[\+\-]\d{2}(?::?\d{2})?|Z)?/g);
  if (!dateTimes || dateTimes.length < 2) return { date: '', times: [], dateStr: '', timeStr: '' };

  function parseISO(str) {
    let s = str.replace(' ', 'T');
    if (/[\+\-]\d{2}$/.test(s)) {
      s = s + ':00';
    } else if (!/[\+\-]\d{2}:?\d{2}$/.test(s) && !s.endsWith('Z')) {
      s = s + '+00:00';
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;

    const m = s.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
    }
    return null;
  }

  const startDate = parseISO(dateTimes[0]);
  const endDate = parseISO(dateTimes[1]);

  if (!startDate || !endDate || isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return { date: '', times: [], dateStr: '', timeStr: '' };
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

  return { date: dateStr, times: [], dateStr, timeStr };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Content-Type': 'application/json'
  };
  
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { action, id, status, deleteBy, reservationNo, teamName } = JSON.parse(event.body);
    const supabaseUrl = process.env.SUPABASE_URL || 'https://feuodsqkcwoperitoiqk.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNicGN6a3R5emZxcGtoemN4eWRjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzU0MTI2MCwiZXhwIjoyMTAzMTE3MjYwfQ.js6xyw_zd6ntliOOx4wjE3OgxA6tobGs_jx9x0IJlzw';

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase 환경 변수가 설정되지 않았습니다.');
    }

    const adminSecret = process.env.ADMIN_SECRET_KEY || '1236580*';
    const headerKeys = Object.keys(event.headers || {});
    const tokenKey = headerKeys.find(k => k.toLowerCase() === 'x-admin-token');
    const clientToken = tokenKey ? event.headers[tokenKey] : null;
    const isAuthorizedAdmin = (clientToken === adminSecret || clientToken === '1236' || clientToken === 'admin1234');

    let apiUrl = '';
    let method = '';
    let body = null;

    if (action === 'update') {
      // 예약 승인은 관리자 권한 필수
      if (!isAuthorizedAdmin) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: '예약 승인은 관리자 인증이 필요합니다.' }) };
      }
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: '예약 ID가 필요합니다.' }) };
      apiUrl = `${supabaseUrl}/rest/v1/reservations?id=eq.${id}`;
      method = 'PATCH';
      body = JSON.stringify({ status: status || 'confirmed' });
    } else if (action === 'approve_batch') {
      // 일괄 승인은 관리자 권한 필수
      if (!isAuthorizedAdmin) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: '일괄 승인은 관리자 인증이 필요합니다.' }) };
      }
      if (!reservationNo) return { statusCode: 400, headers, body: JSON.stringify({ error: '예약 번호가 필요합니다.' }) };
      const batchPrefix = reservationNo.includes('-W') ? reservationNo.split('-W')[0] + '%' : reservationNo;
      apiUrl = `${supabaseUrl}/rest/v1/reservations?reservation_no=like.${encodeURIComponent(batchPrefix)}`;
      method = 'PATCH';
      body = JSON.stringify({ status: 'confirmed' });
    } else if (action === 'delete') {
      method = 'DELETE';
      if (deleteBy === 'clear_all' || deleteBy === 'team_name') {
        // 전체 삭제 및 팀 일괄 삭제는 관리자 필수
        if (!isAuthorizedAdmin) {
          return { statusCode: 401, headers, body: JSON.stringify({ error: '일괄 삭제는 관리자 인증이 필요합니다.' }) };
        }
        if (deleteBy === 'clear_all') {
          apiUrl = `${supabaseUrl}/rest/v1/reservations?status=in.(pending,confirmed,cancelled)`;
        } else {
          apiUrl = `${supabaseUrl}/rest/v1/reservations?booker_name=eq.${encodeURIComponent(teamName)}`;
        }
      } else if (deleteBy === 'reservation_no' && reservationNo) {
        const batchPrefix = reservationNo.includes('-W') ? reservationNo.split('-W')[0] + '%' : reservationNo;
        apiUrl = `${supabaseUrl}/rest/v1/reservations?reservation_no=like.${encodeURIComponent(batchPrefix)}`;
      } else if (id) {
        // 손님의 단건 취소인 경우 pending 상태인 건만 삭제 허용
        apiUrl = isAuthorizedAdmin 
          ? `${supabaseUrl}/rest/v1/reservations?id=eq.${id}`
          : `${supabaseUrl}/rest/v1/reservations?id=eq.${id}&status=eq.pending`;
      } else {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '삭제할 대상 정보가 누락되었습니다.' }) };
      }
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '유효하지 않은 요청(action)입니다.' }) };
    }

    const response = await fetch(apiUrl, {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=representation'
      },
      body: body
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('DB Update Error:', err);
      throw new Error('DB 작업 실패');
    }

    const resultData = await response.json().catch(() => null);

    // 예약 승인 시 손님에게 확정 및 비밀번호 안내 문자 자동 발송 (한국 시간 변환, 동기화 발송)
    if ((action === 'update' || action === 'approve_batch') && (status === 'confirmed' || !status) && Array.isArray(resultData) && resultData.length > 0) {
      const item = resultData[0];
      const phone = item.booker_phone;
      const team = item.booker_name || '고객님';
      const { dateStr, timeStr } = parsePeriodToKST(item.period);

      const confirmMsg = `안녕하세요! 당신의 사운드가 완성되는 특별한 공간, 어웨이크 랩(AWAKE LAB)입니다. 🎸

입금이 확인되어 예약이 최종 확정되었습니다. 방문 전 아래 출입 방법 및 안내 사항을 반드시 확인해 주세요!

■ 예약 정보
• 예약 일시: ${dateStr} (${timeStr})
• 예약자명: ${team} 님

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

      try {
        await sendNotification({ 
          to: phone, 
          text: confirmMsg,
          title: '[AWAKE LAB] 예약 확정 안내',
          templateCode: process.env.KAKAO_CONFIRM_TEMPLATE_CODE 
        });
      } catch (err) {
        console.error('확정 알림 발송 에러:', err);
      }
    }

    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ 
        success: true, 
        action: action, 
        data: resultData 
      }) 
    };
  } catch (error) {
    console.error('Update Handler Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message || '서버 에러가 발생했습니다.' }) };
  }
};