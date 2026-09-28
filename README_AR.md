# RCYTrio Multiplayer Server

هذا هو سيرفر WebSocket للعبة RCYTrio، ومجهز للنشر على Back4app Containers.

## الملفات

- `server.js` — سيرفر HTTP + WebSocket.
- `package.json` — اعتماد Node.js ومكتبة `ws`.
- `Dockerfile` — إعداد Back4app Container.
- `.dockerignore` — ملفات لا تدخل إلى صورة Docker.

## تشغيل محليًا

```bash
npm install
npm start
```

السيرفر يستخدم `PORT` من البيئة، أو 8080 إذا لم يتم تحديده.

اختبار الصحة:

`/health`

## WebSocket

بعد النشر، استخدم عنوان Back4app الذي يعطيك إياه Dashboard بصيغة:

`wss://YOUR-APP-URL`

السيرفر يقبل WebSocket على العنوان بدون الحاجة لمسار `/ws`.

## رسائل العميل المدعومة

- `hello` أو `join`
- `matchmake` / `find_match`
- `cancel_matchmaking`
- `move` / `game_move`
- `state` / `game_state`
- `chat`
- `reaction` / `sticker`
- `leave`
- `ping`

مثال:

```json
{"type":"hello","name":"Player"}
```

ثم:

```json
{"type":"matchmake"}
```

ملاحظة: هذا السيرفر ينسّق المطابقة ويرحّل حركات/رسائل اللاعبين. منطق اللعبة نفسه يجب أن يكون متوافقًا معه داخل ملف RCYTrio HTML.
