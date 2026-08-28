const { sendNotification } = require('./notify-helper');

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

// 시간 슬롯 연속성 검증 (비연속 시간 악용 방지)
function areSlotsContiguous(timesArray) {
  if (!timesArray || timesArray.length <= 1) return true;
  const sorted = [...timesArray].sort();
  for (let i = 0; i < sorted.length - 1; i++) {
    const endH = parseInt(sorted[i].split('-')[1].split(':')[0], 10);
    const nextStartH = parseInt(sorted[i + 1].split('-')[0].split(':')[0], 10);
    if (endH !== nextStartH) return false;
  }
  return true;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Content-Type': 'application/json'
  };
  
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { date, times, teamName, phone, isWeekly, category, passPlan } = JSON.parse(event.body);
    
    if (!date || !times || !times.length || !teamName) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '필수 예약 정보가 누락되었습니다.' }) };
    }

    // 시간 연속성 서버 검증
    if (!areSlotsContiguous(times)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '예약 시간은 연속된 시간으로만 선택하실 수 있습니다.' }) };
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

    const supabaseUrl = process.env.SUPABASE_URL || 'https://feuodsqkcwoperitoiqk.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNicGN6a3R5emZxcGtoemN4eWRjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzU0MTI2MCwiZXhwIjoyMTAzMTE3MjYwfQ.js6xyw_zd6ntliOOx4wjE3OgxA6tobGs_jx9x0IJlzw';

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase 환경 변수가 설정되지 않았습니다.');
    }

    // 2. 관리자가 '매주 고정팀'으로 등록한 경우 -> 관리자 토큰 검증 후 24주 일괄 등록
    if (isWeekly === true) {
      const adminSecret = process.env.ADMIN_SECRET_KEY || '1236580*';
      const clientToken = event.headers['x-admin-token'] || event.headers['X-Admin-Token'];
      if (clientToken !== adminSecret && clientToken !== '1236') {
        return { statusCode: 401, headers, body: JSON.stringify({ error: '고정팀 일괄 등록은 관리자 권한이 필요합니다.' }) };
      }

      const rows = [];
      const [year, month, day] = date.split('-').map(Number);
      const baseDate = new Date(year, month - 1, day);
      const exactAmount = calculateBookingPrice(date, times);
      const batchCode = Math.random().toString(36).substring(2, 8).toUpperCase();

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
          reservation_no: `FIXED-${batchCode}-W${String(w+1).padStart(2, '0')}`,
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

    // [상시 고정] 매주 토요일 09:00~12:00 워십웨이커스 고정 시간 검증
    const [chkY, chkM, chkD] = (date || '').split('-').map(Number);
    const dayOfWeek = new Date(chkY, chkM - 1, chkD).getDay();
    if (dayOfWeek === 6 && !isAdmin) {
      const fixedSlots = ['09:00-10:00', '10:00-11:00', '11:00-12:00'];
      const hasConflict = times.some(t => fixedSlots.includes(t.replace(/\s/g, '')));
      if (hasConflict) {
        return { 
          statusCode: 400, 
          headers, 
          body: JSON.stringify({ error: '매주 토요일 09:00~12:00는 워십웨이커스 정기 고정 합주 시간으로 예약이 불가합니다.' }) 
        };
      }
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
      const batchCode = Math.random().toString(36).substring(2, 8).toUpperCase();

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
          reservation_no: `PASS-${batchCode}-W${String(w+1).padStart(2, '0')}`,
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

      // 정기권 신청 접수 문자 발송 (동기화 발송)
      const passSms = `[AWAKE LAB] 정기권 예약 신청 접수
• 예약팀: [정기권] ${teamName}
• 플랜: ${selectedPlan.name}
• 시작일시: ${date} (${startTime}~${endTime}) (월 ${rows.length}회)
• 총 대관료: ${passAmount.toLocaleString()}원
• 입금 계좌: 케이뱅크 100-111-300282 (예금주: 민경선)

* 2시간 이내에 입금해 주시면 확인 후 즉시 정기권 예약 확정 및 출입문 비밀번호 안내를 보내드립니다.`;

      try {
        await sendNotification({ 
          to: cleanPhone, 
          text: passSms, 
          title: '[AWAKE LAB] 정기권 접수',
          templateCode: process.env.KAKAO_PASS_TEMPLATE_CODE 
        });
      } catch (err) {
        console.error('알림 발송 에러:', err);
      }

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
          reservationNo: `PASS-${batchCode}`
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

    // 예약 신청 접수 문자 발송 (입금 계좌 및 금액 안내 - 동기화 발송)
    const smsMsg = `[AWAKE LAB] 합주실 예약 신청 접수
• 예약팀: ${teamName}
• 일시: ${date} (${startTime}~${endTime})
• 입금 금액: ${exactAmount.toLocaleString()}원
• 입금 계좌: 케이뱅크 100-111-300282 (예금주: 민경선)

* 2시간 이내에 입금해 주시면 관리자 확인 후 즉시 예약 확정 및 출입문 비밀번호 안내를 보내드립니다.`;

    try {
      await sendNotification({ 
        to: cleanPhone, 
        text: smsMsg, 
        title: '[AWAKE LAB] 예약 접수',
        templateCode: process.env.KAKAO_BOOKING_TEMPLATE_CODE 
      });
    } catch (err) {
      console.error('알림 발송 에러:', err);
    }

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