const crypto = require('crypto');

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
      console.log('CoolSMS Confirmation Sent:', data);
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
      console.log('Aligo Confirmation Sent:', data);
      return { success: res.ok, provider: 'aligo', data };
    } catch (e) {
      console.error('Aligo Error:', e);
      return { success: false, error: e.message };
    }
  }

  console.log('SMS API 환경변수 미설정 (발송 스킵)');
  return { skipped: true, reason: 'NO_ENV_KEYS' };
}

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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { action, id, status, deleteBy, reservationNo, teamName } = JSON.parse(event.body);
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase 환경 변수가 설정되지 않았습니다.');
    }

    let apiUrl = '';
    let method = '';
    let body = null;

    if (action === 'update') {
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: '예약 ID가 필요합니다.' }) };
      apiUrl = `${supabaseUrl}/rest/v1/reservations?id=eq.${id}`;
      method = 'PATCH';
      body = JSON.stringify({ status: status || 'confirmed' });
    } else if (action === 'approve_batch') {
      // 같은 batchCode를 공유하는 정기권/고정팀 전체 일괄 승인 (예: PASS-ABCDEF%)
      if (!reservationNo) return { statusCode: 400, headers, body: JSON.stringify({ error: '예약 번호가 필요합니다.' }) };
      const batchPrefix = reservationNo.includes('-W') ? reservationNo.split('-W')[0] + '%' : reservationNo;
      apiUrl = `${supabaseUrl}/rest/v1/reservations?reservation_no=like.${encodeURIComponent(batchPrefix)}`;
      method = 'PATCH';
      body = JSON.stringify({ status: 'confirmed' });
    } else if (action === 'delete') {
      method = 'DELETE';
      if (deleteBy === 'clear_all') {
        apiUrl = `${supabaseUrl}/rest/v1/reservations?status=in.(pending,confirmed,cancelled)`;
      } else if (deleteBy === 'reservation_no' && reservationNo) {
        const batchPrefix = reservationNo.includes('-W') ? reservationNo.split('-W')[0] + '%' : reservationNo;
        apiUrl = `${supabaseUrl}/rest/v1/reservations?reservation_no=like.${encodeURIComponent(batchPrefix)}`;
      } else if (deleteBy === 'team_name' && teamName) {
        apiUrl = `${supabaseUrl}/rest/v1/reservations?booker_name=eq.${encodeURIComponent(teamName)}`;
      } else if (id) {
        apiUrl = `${supabaseUrl}/rest/v1/reservations?id=eq.${id}`;
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

    // 예약 승인 시 손님에게 확정 및 비밀번호 안내 문자 자동 발송 (한국 시간 변환)
    if (action === 'update' && (status === 'confirmed' || !status) && Array.isArray(resultData) && resultData.length > 0) {
      const item = resultData[0];
      const phone = item.booker_phone;
      const team = item.booker_name || '고객님';
      const { dateStr, timeStr } = parsePeriodToKST(item.period);

      const confirmMsg = `[AWAKE LAB] 입금 확인 및 예약이 확정되었습니다!
• 예약팀: ${team}
• 예약일시: ${dateStr} (${timeStr})

[시설 이용 및 출입 안내]
• 진입 유리문 비밀번호: 1236580*
• 입실 방법: 방음문 앞에서 관리자에게 연락 주시면 원격으로 개방해 드립니다.
• 위치: 죽전로 168번길 19
• 퇴실 전 조명 소등 및 정리정돈 부탁드립니다.
감사합니다!`;

      sendSmsNotification({ to: phone, text: confirmMsg }).catch(err => console.error('확정 SMS 발송 에러:', err));
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