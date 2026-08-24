exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase 환경 변수가 설정되지 않았습니다.');
    }

    const response = await fetch(`${supabaseUrl}/rest/v1/reservations?select=*&status=in.(pending,confirmed)&order=created_at.desc`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    if (!response.ok) throw new Error('Supabase DB 조회 실패');

    const data = await response.json();

    const formattedData = data.map(r => {
      let extractDate = "", times = [];
      if (r.period) {
        // [2026-08-25 10:00:00+09, 2026-08-25 12:00:00+09)
        const parts = r.period.replace(/[\[\)"']/g, '').split(',');
        if (parts.length >= 2) {
          const startStr = parts[0].trim();
          const endStr = parts[1].trim();
          
          const startMatch = startStr.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
          const endMatch = endStr.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
          
          if (startMatch && endMatch) {
            extractDate = startMatch[1];
            const startHour = parseInt(startMatch[2], 10);
            const endHour = parseInt(endMatch[2], 10);
            for (let i = startHour; i < endHour; i++) {
              times.push(`${String(i).padStart(2, '0')}:00-${String(i + 1).padStart(2, '0')}:00`);
            }
          }
        }
      }

      const isW = Boolean(r.booker_name && r.booker_name.includes('[고정]'));

      return {
        id: r.id,
        reservationNo: r.reservation_no,
        date: extractDate,
        times: times,
        teamName: r.booker_name || '이름없음',
        phone: r.booker_phone || '',
        amount: r.amount,
        baseAmount: r.base_amount,
        status: r.status || 'pending',
        isWeekly: isW
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify(formattedData) };
  } catch (error) {
    console.error('읽기 에러:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DB 조회 실패' }) };
  }
};