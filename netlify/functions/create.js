const crypto = require('crypto');

// 2026년 공휴일 목록
const holidayList = [
  "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-03-01", "2026-03-02",
  "2026-05-05", "2026-05-24", "2026-05-25", "2026-06-06", "2026-08-15", "2026-08-17",
  "2026-09-24", "2026-09-25", "2026-09-26", "2026-10-03", "2026-10-05", "2026-10-09", "2026-12-25"
];

// 요금 계산기 (주중 25,000원 / 금요일 18시 이후 및 주말·공휴일 30,000원)
function calculateBookingPrice(dateStr, timesArray) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay(); // 0: 일, 5: 금, 6: 토
  const isHoliday = holidayList.includes(dateStr);

  let total = 0;
  timesArray.forEach(slot => {
    const startHour = parseInt(slot.split('-')[0].split(':')[0], 10);
    if (day === 0 || day === 6 || isHoliday) {
      total += 30000; // 주말 또는 공휴일
    } else if (day === 5 && startHour >= 18) {
      total += 30000; // 금요일 18시 이후
    } else {
      total += 25000; // 주중 일반
    }
  });
  return total;
}

// 문자(SMS) 발송 헬퍼 (CoolSMS/Solapi 또는 Aligo 지원)
async function sendSmsNotification({ to, text }) {
  const cleanTo = (to || '').replace(/[^0-9]/g, '');
  if (!cleanTo || cleanTo.length < 10 || cleanTo === '01000000000') {
    return { skipped: true, reason: 'INVALID_PHONE' };
  }

  const coolsmsKey = process.env.COOLSMS_API_KEY || process.env.SOLAPI_API_KEY;
  const coolsmsSecret = process.env.COOLSMS_API_SECRET || process.env.SOLAPI_API_SECRET;
  const sender = process.env.COOLSMS_SENDER_PHONE || process.env.SOLAPI_SENDER_PHONE || process.env.SENDER_PHONE;

  if (coolsmsKey && coolsmsSecret && sender) {
    try {
      const date = new Date().toISOString();
      const salt = crypto.randomBytes(16).toString('hex');
      const signature = crypto.createHmac('sha256', coolsmsSecret).update(`${date}${salt}`).digest('hex');
      const authHeader = `HMAC-SHA256 apiKey=${coolsmsKey}, date=${date}, salt=${salt}, signature=${signature}`;

      const res = await fetch('https://api.coolsms.com/messages/v4/send', {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: {
            to: cleanTo,
            from: sender.replace(/[^0-9]/g, ''),
            text: text
          }
        })
      });
      const data = await res.json();
      console.log('CoolSMS Response:', data);
      return { success: res.ok, provider: 'coolsms', data };
    } catch (e) {
      console.error('CoolSMS Error:', e);
      return { success: false, error: e.message };
    }
  }

  const aligoKey = process.env.ALIGO_API_KEY;
  const aligoUser = process.env.ALIGO_USER_ID;
  const aligoSender = process.env.ALIGO_SENDER_PHONE || sender;

  if (aligoKey && aligoUser && aligoSender) {
    try {
      const formData = new URLSearchParams();
      formData.append('key', aligoKey);
      formData.append('user_id', aligoUser);
      formData.append('sender', aligoSender.replace(/[^0-9]/g, ''));
      formData.append('receiver', cleanTo);
      formData.append('msg', text);

      const res = await fetch('https://apis.aligo.in/send/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
      });
      const data = await res.json();
      console.log('Aligo Response:', data);
      return { success: res.ok, provider: 'aligo', data };
    } catch (e) {
      console.error('Aligo Error:', e);
      return { success: false, error: e.message };
    }
  }

  console.log('SMS API 환경변수 미설정 (발송 스킵)');
  return { skipped: true, reason: 'NO_ENV_KEYS' };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { date, times, teamName, phone, isWeekly, category, passPlan } = JSON.parse(event.body);
    
    if (!date || !times || !times.length || !teamName) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '필수 예약 정보가 누락되었습니다.' }) };
    }

    // 일반 예약인 경우 기본 2시간 이상 체크
    if (!isWeekly && category !== 'pass' && times.length < 2) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '합주실 대관은 기본 2시간 이상부터 가능합니다.' }) };
    }

    // 1. 예약 시간 범위 계산 (KST 기준)
    const sortedTimes = [...times].sort();
    const startTime = sortedTimes[0].split('-')[0].trim();
    const endTime = sortedTimes[sortedTimes.length - 1].split('-')[1].trim();

    const cleanPhone = (phone || '').replace(/[^0-9]/g, '');

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase 환경 변수가 설정되지 않았습니다.');
    }

    // 2. 관리자가 '매주 고정팀'으로 등록한 경우 -> 향후 24주(약 6개월) 일괄 등록
    if (isWeekly === true) {
      const rows = [];
      const [year, month, day] = date.split('-').map(Number);
      const baseDate = new Date(year, month - 1, day);
      const exactAmount = calculateBookingPrice(date, times);
      const batchResNo = 'FIXED-' + Math.random().toString(36).substring(2, 10).toUpperCase();

      for (let w = 0; w < 24; w++) {
        const targetDate = new Date(baseDate);
        targetDate.setDate(baseDate.getDate() + (w * 7));
        
        const y = targetDate.getFullYear();
        const m = String(targetDate.getMonth() + 1).padStart(2, '0');
        const d = String(targetDate.getDate()).padStart(2, '0');
        const dateStr = `${y}-${m}-${d}`;
        const periodStr = `[${dateStr} ${startTime}:00+09, ${dateStr} ${endTime}:00+09)`;
        const weekPrice = calculateBookingPrice(dateStr, times);

        rows.push({
          reservation_no: batchResNo,
          room_id: 1,
          period: periodStr,
          status: 'confirmed', // 고정팀은 관리자 직접 등록이므로 확정 상태
          booker_name: teamName.includes('[고정]') ? teamName : `[고정] ${teamName}`,
          booker_phone: cleanPhone,
          base_amount: weekPrice,
          amount: weekPrice
        });
      }

      const response = await fetch(`${supabaseUrl}/rest/v1/reservations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(rows)
      });

      if (!response.ok) {
        const errorData = await response.json();
        if (errorData.code === '23P01') {
          return { statusCode: 409, headers, body: JSON.stringify({ error: '고정팀 일정 중 이미 다른 예약이 있는 날짜가 포함되어 있습니다.' }) };
        }
        throw new Error('Supabase 고정팀 일괄 저장 실패');
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          isWeekly: true,
          amount: exactAmount,
          message: '향후 24주간의 매주 고정팀 일정이 성공적으로 등록되었습니다.'
        })
      };
    }

    // ── 이하 일반 사용자 예약: KST 기준 오늘 날짜 계산 ──
    const now = new Date();
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const kstTime = new Date(utcTime + (9 * 60 * 60 * 1000));
    const kstYear = kstTime.getFullYear();
    const kstMonth = String(kstTime.getMonth() + 1).padStart(2, '0');
    const kstDay = String(kstTime.getDate()).padStart(2, '0');
    const todayKST = `${kstYear}-${kstMonth}-${kstDay}`;

    if (date < todayKST) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `오늘(${todayKST}) 이전 날짜에는 예약할 수 없습니다.` }) };
    }

    // 전화번호 필수 검증
    if (!cleanPhone || cleanPhone.length < 10) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '올바른 휴대폰 번호를 입력해주세요.' }) };
    }

    // 3. 정기권 (월 4회 정기 우대) 신청인 경우 -> 4주간 동일 요일/시간 일괄 선점 등록
    if (category === 'pass') {
      const passPriceMap = {
        'church_a': { name: '교회형 정기권 A (주말 2h)', amount: 200000 },
        'church_b': { name: '교회형 정기권 B (주말 3h)', amount: 290000 },
        'work_a': { name: '직장형 정기권 A (주중 2h)', amount: 160000 },
        'work_b': { name: '직장형 정기권 B (주중 3h)', amount: 276000 }
      };

      const selectedPlan = passPriceMap[passPlan] || passPriceMap['work_a'];
      const passAmount = selectedPlan.amount;
      const singleWeekAmount = Math.round(passAmount / 4);

      const rows = [];
      const [year, month, day] = date.split('-').map(Number);
      const baseDate = new Date(year, month - 1, day);
      const batchResNo = 'PASS-' + Math.random().toString(36).substring(2, 10).toUpperCase();

      for (let w = 0; w < 4; w++) {
        const targetDate = new Date(baseDate);
        targetDate.setDate(baseDate.getDate() + (w * 7));
        
        const y = targetDate.getFullYear();
        const m = String(targetDate.getMonth() + 1).padStart(2, '0');
        const d = String(targetDate.getDate()).padStart(2, '0');
        const dateStr = `${y}-${m}-${d}`;

        // 과거 날짜 자동 스킵 (오늘 이후만 등록)
        if (dateStr < todayKST) continue;

        const periodStr = `[${dateStr} ${startTime}:00+09, ${dateStr} ${endTime}:00+09)`;

        rows.push({
          reservation_no: batchResNo,
          room_id: 1,
          period: periodStr,
          status: 'pending',
          booker_name: teamName.includes('[정기권]') ? teamName : `[정기권] ${teamName}`,
          booker_phone: cleanPhone,
          base_amount: singleWeekAmount,
          amount: w === 0 ? passAmount : 0 // 첫 주에 총 입금액 기록
        });
      }

      if (rows.length === 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '선택하신 날짜를 포함한 4주 일정이 모두 과거입니다. 다시 날짜를 선택해주세요.' }) };
      }

      const response = await fetch(`${supabaseUrl}/rest/v1/reservations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(rows)
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorData = {};
        try { errorData = JSON.parse(errorText); } catch(e) {}
        if (errorData.code === '23P01') {
          return { statusCode: 409, headers, body: JSON.stringify({ error: '선택하신 시간(또는 정기권 4주 일정 중 일부)에 이미 등록된 예약이 존재합니다.\n\n관리자 모드에서 [📋 전체 예약 목록]을 열어 [팀전체삭제]로 기존 데이터를 정리한 후 다시 신청해 주세요.' }) };
        }
        console.error('Supabase 정기권 저장 실패:', errorText);
        return { statusCode: 500, headers, body: JSON.stringify({ error: `DB 저장 실패: ${errorData.message || errorText}` }) };
      }

      // 정기권 신청 접수 문자 발송
      const passSms = `[AWAKE LAB] 정기권 예약 신청 접수
• 예약팀: [정기권] ${teamName}
• 플랜: ${selectedPlan.name}
• 시작일시: ${date} (${startTime}~${endTime}) (월 ${rows.length}회)
• 총 대관료: ${passAmount.toLocaleString()}원
• 입금 계좌: 케이뱅크 100-111-300282 (예금주: 민경선)

* 2시간 이내에 입금해 주시면 확인 후 즉시 정기권 예약 확정 및 출입문 비밀번호 안내를 보내드립니다.`;

      sendSmsNotification({ to: cleanPhone, text: passSms }).catch(err => console.error('SMS 발송 에러:', err));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          isPass: true,
          amount: passAmount,
          baseAmount: passAmount,
          planName: selectedPlan.name,
          teamName: teamName,
          date: date,
          timeRange: `${startTime}~${endTime}`,
          weeksRegistered: rows.length,
          reservationNo: batchResNo
        })
      };
    }

    // 4. 일반 사용자 단건 예약 신청
    const exactAmount = calculateBookingPrice(date, times);
    const periodStr = `[${date} ${startTime}:00+09, ${date} ${endTime}:00+09)`;
    const reservationNo = Math.random().toString(36).substring(2, 12).toUpperCase();

    const response = await fetch(`${supabaseUrl}/rest/v1/reservations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        reservation_no: reservationNo,
        room_id: 1,
        period: periodStr,
        status: 'pending',
        booker_name: teamName,
        booker_phone: cleanPhone,
        base_amount: exactAmount,
        amount: exactAmount
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData = {};
      try { errorData = JSON.parse(errorText); } catch(e) {}
      if (errorData.code === '23P01') {
        return { statusCode: 409, headers, body: JSON.stringify({ error: '방금 다른 분이 해당 시간을 먼저 예약했습니다. 다른 시간을 선택해주세요.' }) };
      }
      console.error('Supabase 단건 저장 실패:', errorText);
      return { statusCode: 500, headers, body: JSON.stringify({ error: `DB 저장 실패: ${errorData.message || errorText}` }) };
    }

    // 예약 신청 접수 문자 발송 (입금 계좌 및 금액 안내)
    const smsMsg = `[AWAKE LAB] 합주실 예약 신청 접수
• 예약팀: ${teamName}
• 일시: ${date} (${startTime}~${endTime})
• 입금 금액: ${exactAmount.toLocaleString()}원
• 입금 계좌: 케이뱅크 100-111-300282 (예금주: 민경선)

* 2시간 이내에 입금해 주시면 관리자 확인 후 즉시 예약 확정 및 출입문 비밀번호 안내를 보내드립니다.`;

    sendSmsNotification({ to: cleanPhone, text: smsMsg }).catch(err => console.error('SMS 발송 에러:', err));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        amount: exactAmount,
        baseAmount: exactAmount,
        reservationNo: reservationNo,
        teamName: teamName,
        date: date,
        timeRange: `${startTime}~${endTime}`
      })
    };

  } catch (error) {
    console.error('서버 에러:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: `서버 처리 중 오류: ${error.message || error}` }) };
  }
};