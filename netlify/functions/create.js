exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { date, times, teamName, phone } = JSON.parse(event.body);
    
    const sortedTimes = times.sort();
    const startTime = sortedTimes[0].split('-')[0].trim();
    const endTime = sortedTimes[sortedTimes.length - 1].split('-')[1].trim();
    const periodStr = `[${date} ${startTime}:00+09, ${date} ${endTime}:00+09)`;

    const reservationNo = Math.random().toString(36).substring(2, 12).toUpperCase();

    // ★ 할증 요금 스마트 계산기 시작 ★
    // 공휴일 리스트 (매년 업데이트 필요)
    const holidays = ["2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-03-01", "2026-05-05", "2026-05-24", "2026-06-06", "2026-08-15", "2026-09-24", "2026-09-25", "2026-09-26", "2026-10-03", "2026-10-09", "2026-12-25"];
    
    const reqDate = new Date(date);
    const dayOfWeek = reqDate.getDay(); // 0:일, 1:월, 2:화, 3:수, 4:목, 5:금, 6:토
    const isHoliday = holidays.includes(date);
    
    let baseAmount = 0;
    
    times.forEach(t => {
        const hour = parseInt(t.split(':')[0]); // '15:00-16:00' 에서 '15' 추출
        
        // 공휴일(O) 또는 주말(토,일)이거나, 금요일(5) 18시 이후라면 주말 요금 30,000원!
        if (isHoliday || dayOfWeek === 0 || dayOfWeek === 6 || (dayOfWeek === 5 && hour >= 18)) {
            baseAmount += 30000;
        } else {
            // 그 외 평일은 25,000원
            baseAmount += 25000;
        }
    });
    // ★ 할증 요금 스마트 계산기 끝 ★

    // 자동 입금 확인을 위한 유니크 난수(1~99원) 추가
    const uniqueAmount = baseAmount + Math.floor(Math.random() * 99) + 1;

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
        booker_phone: phone || '010-0000-0000',
        base_amount: baseAmount,
        amount: uniqueAmount
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      if (errorData.code === '23P01') {
        return { statusCode: 409, headers, body: JSON.stringify({ error: '방금 다른 분이 예약했습니다. 다시 시도해주세요.' }) };
      }
      throw new Error('Supabase 저장 실패');
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, amount: uniqueAmount, reservationNo: reservationNo })
    };

  } catch (error) {
    console.error('서버 에러:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 처리 중 오류가 발생했습니다.' }) };
  }
};
