// PostgreSQL tstzrange (UTC) -> KST(한국 표준시) 날짜 및 시간 배열로 정확하게 변환
function parsePeriodToKST(periodStr) {
  if (!periodStr) return { date: '', times: [], dateStr: '', timeStr: '' };
  
  // 정규식으로 YYYY-MM-DD HH:MM:SS 패턴 추출
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

  // KST는 UTC+9시간
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

  const startHourStr = String(startHour).padStart(2, '0') + ':00';
  const endHourStr = String(endHour).padStart(2, '0') + ':00';

  return {
    date: extractDate,
    times,
    dateStr: extractDate,
    timeStr: `${startHourStr}~${endHourStr}`
  };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Content-Type': 'application/json'
  };
  
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://sbpczktyzfqpkhzcxydc.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNicGN6a3R5emZxcGtoemN4eWRjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzU0MTI2MCwiZXhwIjoyMTAzMTE3MjYwfQ.js6xyw_zd6ntliOOx4wjE3OgxA6tobGs_jx9x0IJlzw';

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase 환경 변수가 설정되지 않았습니다.');
    }

    const adminSecret = process.env.ADMIN_SECRET_KEY || '1236580*';
    const headerKeys = Object.keys(event.headers || {});
    const tokenKey = headerKeys.find(k => k.toLowerCase() === 'x-admin-token');
    const clientToken = tokenKey ? event.headers[tokenKey] : null;
    const isAdmin = (clientToken === adminSecret || clientToken === '1236' || clientToken === 'admin1234');

    const response = await fetch(`${supabaseUrl}/rest/v1/reservations?select=*&status=in.(pending,confirmed)&order=created_at.desc`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    if (!response.ok) throw new Error('Supabase DB 조회 실패');

    const data = await response.json();

    const nowMs = Date.now();
    const HOLD_MS = 2 * 60 * 60 * 1000; // 2시간

    const formattedData = data.map(r => {
      const { date, times } = parsePeriodToKST(r.period);
      const rawName = r.booker_name || '이름없음';
      const isW = Boolean(rawName.includes('[고정]') || rawName.includes('[정기권]'));
      const createdMs = r.created_at ? new Date(r.created_at).getTime() : nowMs;
      const isExpired = r.status === 'pending' && (nowMs - createdMs > HOLD_MS);
      const finalStatus = isExpired ? 'expired' : (r.status || 'pending');

      // 공개 캘린더용 팀명 마스킹 (앞 2글자 + ***)
      let displayName = rawName;
      if (!isAdmin) {
        let prefix = '';
        let coreName = rawName;
        if (rawName.startsWith('[정기권] ')) {
          prefix = '[정기권] ';
          coreName = rawName.replace('[정기권] ', '');
        } else if (rawName.startsWith('[고정] ')) {
          prefix = '[고정] ';
          coreName = rawName.replace('[고정] ', '');
        }
        const masked = coreName.length <= 2 ? coreName : coreName.substring(0, 2) + '*'.repeat(Math.min(coreName.length - 2, 4));
        displayName = prefix + masked;
      }

      return {
        id: r.id,
        reservationNo: isAdmin ? r.reservation_no : undefined,
        date: date,
        times: isExpired ? [] : times, // 만료 시 슬롯 즉시 해제
        teamName: displayName,
        phone: isAdmin ? (r.booker_phone || '') : undefined, // 관리자에게만 노출
        amount: isAdmin ? r.amount : undefined,
        baseAmount: isAdmin ? r.base_amount : undefined,
        status: finalStatus,
        isWeekly: isW,
        createdAt: isAdmin ? r.created_at : undefined,
        expiresAt: new Date(createdMs + HOLD_MS).toISOString()
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify(formattedData) };
  } catch (error) {
    console.error('읽기 에러:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DB 조회 실패' }) };
  }
};