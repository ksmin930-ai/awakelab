exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const response = await fetch(`${supabaseUrl}/rest/v1/reservations?select=*&status=in.(pending,confirmed)`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    const data = await response.json();

    const formattedData = data.map(r => {
      const match = r.period.match(/\["?(\d{4}-\d{2}-\d{2}) (\d{2}):\d{2}:\d{2}.*?,"?(\d{4}-\d{2}-\d{2}) (\d{2}):\d{2}:\d{2}.*?\)/);
      let extractDate = "", times = [];
      if (match) {
         extractDate = match[1];
         let startHour = parseInt(match[2]);
         let endHour = parseInt(match[4]);
         for(let i = startHour; i < endHour; i++) {
             times.push(`${String(i).padStart(2, '0')}:00-${String(i+1).padStart(2, '0')}:00`);
         }
      }
      return { id: r.id, date: extractDate, times: times, teamName: r.booker_name, status: r.status, isWeekly: false };
    });

    return { statusCode: 200, headers, body: JSON.stringify(formattedData) };
  } catch (error) {
    console.error('읽기 에러:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DB 조회 실패' }) };
  }
};