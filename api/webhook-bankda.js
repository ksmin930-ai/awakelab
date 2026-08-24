const { handler } = require('../netlify/functions/webhook-bankda');

module.exports = async (req, res) => {
  const event = {
    httpMethod: req.method,
    headers: req.headers,
    body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}),
    queryStringParameters: req.query
  };
  const result = await handler(event, {});
  res.status(result.statusCode);
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) {
      res.setHeader(k, v);
    }
  }
  return res.send(result.body);
};
