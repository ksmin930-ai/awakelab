// PostgreSQL tstzrange (UTC) -> KST(한국 표준시) 날짜 및 시간 배열 변환
function parsePeriodToKST(periodStr) {
  if (!periodStr) return { date: '', times: [] };
  
  const dateTimes = periodStr.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[\+\-]\d{2}(?::?\d{2})?|Z)?/g);
  if (!dateTimes || dateTimes.length < 2) return { date: '', times: [] };

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
    return { date: '', times: [] };
  }

  const kstOffsetMs = 9 * 60 * 60 * 1000;
  const startKst = new Date(startDate.getTime() + kstOffsetMs);
  const endKst = new Date(endDate.getTime() + kstOffsetMs);

  const y = startKst.getUTCFullYear();
  const m = String(startKst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(startKst.getUTCDate()).padStart(2, '0');
  const extractDate = `${y}-${m}-${d}`;

  const times = [];
  for (let h = startKst.getUTCHours(); h < endKst.getUTCHours(); h++) {
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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { query } = JSON.parse(event.body || '{}');
    if (!query || query.trim().length < 4) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '올바른 휴대폰 번호 또는 예약번호를 4자리 이상 입력해주세요.' }) };
    }

    const supabaseUrl = process.env.SUPABASE_URL || 'https://feuodsqkcwoperitoiqk.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNicGN6a3R5emZxcGtoemN4eWRjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzU0MTI2MCwiZXhwIjoyMTAzMTE3MjYwfQ.js6xyw_zd6ntliOOx4wjE3OgxA6tobGs_jx9x0IJlzw';

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase 환경 변수가 설정되지 않았습니다.');
    }

    const cleanDigits = query.replace(/[^0-9]/g, '');
    const cleanAlpha = query.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

    // 휴대폰 번호 또는 예약번호로 검색 (PostgREST ilike)
    let filterQuery = '';
    if (cleanDigits.length >= 8) {
      filterQuery = `booker_phone=like.*${cleanDigits}*`;
    } else if (cleanAlpha.length >= 4) {
      filterQuery = `reservation_no=ilike.*${cleanAlpha}*`;
    } else {
      filterQuery = `booker_phone=like.*${cleanDigits}*`;
    }

    const response = await fetch(`${supabaseUrl}/rest/v1/reservations?${filterQuery}&order=created_at.desc`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    if (!response.ok) throw new Error('DB 조회 실패');

    const data = await response.json();
    const nowMs = Date.now();
    const HOLD_MS = 2 * 60 * 60 * 1000;

    const formattedData = data.map(r => {
      const { date, times } = parsePeriodToKST(r.period);
      const isW = Boolean(r.booker_name && (r.booker_name.includes('[고정]') || r.booker_name.includes('[정기권]')));
      const createdMs = r.created_at ? new Date(r.created_at).getTime() : nowMs;
      const isExpired = r.status === 'pending' && (nowMs - createdMs > HOLD_MS);
      const finalStatus = isExpired ? 'expired' : (r.status || 'pending');

      return {
        id: r.id,
        reservationNo: r.reservation_no,
        date: date,
        times: times,
        teamName: r.booker_name || '이름없음',
        phone: r.booker_phone ? r.booker_phone.replace(/(\d{3})\d{4}(\d{4})/, '$1-****-$2') : '', // 마스킹
        amount: r.amount,
        baseAmount: r.base_amount,
        status: finalStatus,
        isWeekly: isW,
        createdAt: r.created_at,
        expiresAt: new Date(createdMs + HOLD_MS).toISOString()
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify(formattedData) };
  } catch (err) {
    console.error('Lookup API Error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '조회 중 오류가 발생했습니다.' }) };
  }
};
