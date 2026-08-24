exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { action, id, status } = JSON.parse(event.body);
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    let apiUrl = `${supabaseUrl}/rest/v1/reservations?id=eq.${id}`;
    let method = '';
    let body = null;

    if (action === 'update') {
      method = 'PATCH'; // 상태 수정
      body = JSON.stringify({ status: status });
    } else if (action === 'delete') {
      method = 'DELETE'; // 데이터 삭제
    }

    const response = await fetch(apiUrl, {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal'
      },
      body: body
    });

    if (!response.ok) throw new Error('DB 업데이트 실패');

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch (error) {
    console.error(error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 에러' }) };
  }
};