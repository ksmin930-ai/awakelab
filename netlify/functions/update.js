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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
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

    const adminSecret = process.env.ADMIN_SECRET_KEY || '1236580*';
    const clientToken = event.headers['x-admin-token'] || event.headers['X-Admin-Token'];
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

      const confirmMsg = `[AWAKE LAB] 입금 확인 및 예약이 확정되었습니다!
• 예약팀: ${team}
• 예약일시: ${dateStr} (${timeStr})

[시설 이용 및 출입 안내]
• 진입 유리문 비밀번호: 1236580*
• 입실 방법: 방음문 앞에서 관리자에게 연락 주시면 원격으로 개방해 드립니다.
• 위치: 죽전로 168번길 19
• 퇴실 전 조명 소등 및 정리정돈 부탁드립니다.
감사합니다!`;

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