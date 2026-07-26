curl -X POST "https://radalirad.runflare.run/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "Content-Type: application/json" \
  -H "x-api-key: b97379bec0b236eef74914cbcfb3353d5a59a169666e7eaf630454dba59ac35b" \
  -d '{
    "contents": [
      { "parts": [{ "text": "سلام، خودت رو معرفی کن" }] }
    ]
  }'

  curl -X POST "https://radalirad.runflare.run/v1beta/interactions" \
  -H "x-api-key: b97379bec0b236eef74914cbcfb3353d5a59a169666e7eaf630454dba59ac35b" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gemini-2.5-flash",
    "input": "سلامو درود"
  }'