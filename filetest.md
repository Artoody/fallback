curl -X POST "https://radalirad.runflare.run/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_PROXY_API_KEY" \
  -d '{
    "contents": [
      { "parts": [{ "text": "سلام، خودت رو معرفی کن" }] }
    ]
  }'

  curl -X POST "https://radalirad.runflare.run/v1beta/interactions" \
  -H "x-api-key: YOUR_PROXY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gemini-2.5-flash",
    "input": "سلامو درود"
  }'