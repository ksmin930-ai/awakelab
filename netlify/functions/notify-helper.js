const crypto = require('crypto');

/**
 * 카카오톡 알림톡 및 SMS/LMS 통합 발송 헬퍼
 * Solapi(CoolSMS) 또는 Aligo 게이트웨이를 통해 알림톡 우선 발송 및 실패 시 SMS 자동 대체
 */
async function sendNotification({ to, text, templateCode, title, buttons }) {
  const cleanTo = (to || '').replace(/[^0-9]/g, '');
  if (!cleanTo || cleanTo.length < 10 || cleanTo === '01000000000') {
    return { skipped: true, reason: 'INVALID_PHONE' };
  }

  // 1. Solapi / CoolSMS 지원 (알림톡 + SMS/LMS 대체)
  const coolsmsKey = process.env.COOLSMS_API_KEY || process.env.SOLAPI_API_KEY || 'NCSVL2WDFJJSCETU';
  const coolsmsSecret = process.env.COOLSMS_API_SECRET || process.env.SOLAPI_API_SECRET || '5XC5NBGUTT9DYPDXMPPQOC81K5JM9OGO';
  const sender = process.env.COOLSMS_SENDER_PHONE || process.env.SOLAPI_SENDER_PHONE || process.env.SENDER_PHONE || '01062406569';
  const pfId = process.env.SOLAPI_PF_ID || process.env.KAKAO_PF_ID; // 카카오톡 채널 ID

  if (coolsmsKey && coolsmsSecret && sender) {
    try {
      const date = new Date().toISOString();
      const salt = crypto.randomBytes(16).toString('hex');
      const signature = crypto.createHmac('sha256', coolsmsSecret).update(`${date}${salt}`).digest('hex');
      const authHeader = `HMAC-SHA256 apiKey=${coolsmsKey}, date=${date}, salt=${salt}, signature=${signature}`;

      const messagePayload = {
        to: cleanTo,
        from: sender.replace(/[^0-9]/g, ''),
        text: text,
        subject: title || '[AWAKE LAB]'
      };

      // 카카오톡 알림톡 템플릿이 등록되어 있는 경우 알림톡 설정 추가
      if (pfId && templateCode) {
        messagePayload.kakaoOptions = {
          pfId: pfId,
          templateId: templateCode,
          disableSms: false // 카카오톡 실패 시 SMS 자동 대체(Failover)
        };
        if (buttons && Array.isArray(buttons)) {
          messagePayload.kakaoOptions.buttons = buttons;
        }
      }

      const res = await fetch('https://api.coolsms.com/messages/v4/send', {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: messagePayload })
      });
      const data = await res.json();
      console.log('Solapi/CoolSMS Sent:', data);
      return { success: res.ok, provider: 'solapi', data };
    } catch (e) {
      console.error('Solapi Error:', e);
      return { success: false, error: e.message };
    }
  }

  // 2. Aligo 지원 (알림톡 / SMS)
  const aligoKey = process.env.ALIGO_API_KEY;
  const aligoUser = process.env.ALIGO_USER_ID;
  const aligoSender = process.env.ALIGO_SENDER_PHONE || sender;
  const aligoSenderKey = process.env.ALIGO_SENDER_KEY || process.env.KAKAO_SENDER_KEY;

  if (aligoKey && aligoUser && aligoSender) {
    try {
      let endpoint = 'https://apis.aligo.in/send/';
      const formData = new URLSearchParams();
      formData.append('key', aligoKey);
      formData.append('user_id', aligoUser);
      formData.append('sender', aligoSender.replace(/[^0-9]/g, ''));
      formData.append('receiver', cleanTo);
      formData.append('msg', text);
      formData.append('title', title || '[AWAKE LAB]');

      // 알림톡 템플릿 설정이 있는 경우 알림톡 엔드포인트 사용
      if (aligoSenderKey && templateCode) {
        endpoint = 'https://kakaoapi.aligo.in/akv10/alimtalk/send/';
        formData.append('senderkey', aligoSenderKey);
        formData.append('tpl_code', templateCode);
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
      });
      const data = await res.json();
      console.log('Aligo Sent:', data);
      return { success: res.ok, provider: 'aligo', data };
    } catch (e) {
      console.error('Aligo Error:', e);
      return { success: false, error: e.message };
    }
  }

  console.log('알림 API 환경변수 미설정 (발송 시뮬레이션 성공 처리)');
  return { skipped: true, reason: 'NO_ENV_KEYS' };
}

module.exports = { sendNotification };
