// PostgreSQL tstzrange (UTC) -> KST(한국 표준시) 날짜 및 시간 배열로 정확하게 변환
function parsePeriodToKST(periodStr) {
  if (!periodStr) return { date: '', times: [] };
  
  // 예: '["2026-08-15 00:00:00+00","2026-08-15 03:00:00+00")' 또는 '[2026-08-15 00:00:00+00, 2026-08-15 03:00:00+00)'
  const clean = periodStr.replace(/[\[\)"']/g, '');
  const parts = clean.split(',').map(s => s.trim());
  if (parts.length < 2) return { date: '', times: [] };

  const startRaw = parts[0].replace(' ', 'T');
  const endRaw = parts[1].replace(' ', 'T');

  const startDate = new Date(startRaw);
  const endDate = new Date(endRaw);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return { date: '', times: [] };
  }

  // KST는 UTC+9시간 (9 * 3600 * 1000 ms)
  const kstOffsetMs = 9 * 60 * 60 * 1000;
  const startKst = new Date(startDate.getTime() + kstOffsetMs);
  const endKst = new Date(endDate.getTime() + kstOffsetMs);

  const y = startKst.getUTCFullYear();
  const m = String(startKst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(startKst.getUTCDate()).padStart(2, '0');
  const extractDate = `${y}-${m}-${d}`;

  const startHour = startKst.getUTCHours();
  const endHour = endKst.getUTCHours();

  const times = [];
  for (let h = startHour; h < endHour; h++) {
    times.push(`${String(h).padStart(2, '0')}:00-${String(h + 1).padStart(2, '0')}:00`);
  }

  return { date: extractDate, times };
}

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
      const { date, times } = parsePeriodToKST(r.period);
      const isW = Boolean(r.booker_name && (r.booker_name.includes('[고정]') || r.booker_name.includes('[정기권]')));

      return {
        id: r.id,
        reservationNo: r.reservation_no,
        date: date,
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