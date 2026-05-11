const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const BOOKINGS_FILE = path.join(__dirname, 'data', 'bookings.json');
const CLOSED_DAYS_FILE = path.join(__dirname, 'data', 'closed-days.json');
const BLOCKED_SLOTS_FILE = path.join(__dirname, 'data', 'blocked-slots.json');

// ===== 設定 =====
const BUSINESS_NAME = 'kaji清掃';
const BUSINESS_AREA = '津山市・美作市・真庭市';
const BUSINESS_PHONE = '〇〇〇-〇〇〇〇-〇〇〇〇'; // ← 実際の電話番号に変更
const BUSINESS_EMAIL = '〇〇@〇〇.com'; // ← 実際のGmailに変更
const OPEN_HOUR  = 9 * 60;   // 9:00
const CLOSE_HOUR = 18 * 60;  // 18:00
const CLOSED_WEEKDAY = 3;    // 3 = 水曜日定休
const SLOT_INTERVAL = 30;    // 予約開始時刻の間隔(分)
const MAX_SIMULTANEOUS = 1;  // 同時受付件数（一人なので1）
const TRAVEL_BUFFER = 40;    // 予約前後の移動バッファ（分）

// ===== サービス定義 =====
const SERVICES = {
  'aircon':       { name: 'エアコン清掃（壁掛け型）',     price: 8800,  duration: 150 },
  'aircon-clean': { name: 'エアコン清掃（お掃除機能付）', price: 13200, duration: 180 },
  'rangehood':    { name: 'レンジフード清掃',             price: 11000, duration: 150 },
  'washer':       { name: '洗濯機清掃（縦型）',           price: 11000, duration: 150 },
  'washer-drum':  { name: '洗濯機清掃（ドラム式）',       price: 16500, duration: 180 },
  'bath':         { name: 'お風呂清掃',                   price: 13200, duration: 180 },
  'kitchen':      { name: 'キッチン清掃',                 price: 11000, duration: 150 },
  'toilet':       { name: 'トイレ清掃',                   price: 5500,  duration: 90  },
  'ventilation':  { name: '換気扇清掃',                   price: 8800,  duration: 120 },
};

// ===== 祝日リスト (YYYY-MM-DD) =====
const HOLIDAYS = new Set([
  '2025-01-01','2025-01-13','2025-02-11','2025-02-23','2025-02-24',
  '2025-03-20','2025-04-29','2025-05-03','2025-05-04','2025-05-05','2025-05-06',
  '2025-07-21','2025-08-11','2025-09-15','2025-09-23','2025-10-13',
  '2025-11-03','2025-11-23','2025-11-24',
  '2026-01-01','2026-01-12','2026-02-11','2026-02-23','2026-03-20',
  '2026-04-29','2026-05-03','2026-05-04','2026-05-05','2026-05-06',
  '2026-07-20','2026-08-11','2026-09-21','2026-09-22','2026-09-23',
  '2026-10-12','2026-11-03','2026-11-23',
  '2027-01-01','2027-01-11','2027-02-11','2027-02-23','2027-03-21','2027-03-22',
  '2027-04-29','2027-05-03','2027-05-04','2027-05-05',
  '2027-07-19','2027-08-11','2027-09-20','2027-09-23','2027-10-11',
  '2027-11-03','2027-11-23',
]);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== ヘルパー =====
function loadBookings() {
  if (!fs.existsSync(BOOKINGS_FILE)) fs.writeFileSync(BOOKINGS_FILE, '[]');
  return JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8'));
}
function saveBookings(b) { fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(b, null, 2)); }

function loadClosedDays() {
  if (!fs.existsSync(CLOSED_DAYS_FILE)) fs.writeFileSync(CLOSED_DAYS_FILE, '[]');
  return new Set(JSON.parse(fs.readFileSync(CLOSED_DAYS_FILE, 'utf8')));
}
function saveClosedDays(set) {
  fs.writeFileSync(CLOSED_DAYS_FILE, JSON.stringify([...set].sort(), null, 2));
}

function loadBlockedSlots() {
  if (!fs.existsSync(BLOCKED_SLOTS_FILE)) fs.writeFileSync(BLOCKED_SLOTS_FILE, '[]');
  return JSON.parse(fs.readFileSync(BLOCKED_SLOTS_FILE, 'utf8'));
}
function saveBlockedSlots(list) { fs.writeFileSync(BLOCKED_SLOTS_FILE, JSON.stringify(list, null, 2)); }

function isClosedDay(date) {
  if (CLOSED_WEEKDAY >= 0 && new Date(date + 'T00:00:00').getDay() === CLOSED_WEEKDAY) return true;
  if (HOLIDAYS.has(date)) return true;
  return loadClosedDays().has(date);
}

function timeToMins(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function minsToTime(m) { return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`; }
function overlaps(s1, e1, s2, e2) { return s1 < e2 && e1 > s2; }

// ===== API =====

// GET /api/availability?date=YYYY-MM-DD&serviceId=aircon
app.get('/api/availability', (req, res) => {
  const { date, serviceId } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });

  if (isClosedDay(date)) return res.json({ date, closed: true, slots: [] });

  const svc = SERVICES[serviceId];
  const dur = svc ? svc.duration : 60;
  const bookings = loadBookings().filter(b => b.date === date);
  const blocks = loadBlockedSlots().filter(b => b.date === date);

  const slots = [];
  for (let start = OPEN_HOUR; start + dur <= CLOSE_HOUR; start += SLOT_INTERVAL) {
    const end = start + dur;
    const isBlocked = blocks.some(b =>
      overlaps(start, end, timeToMins(b.fromTime), timeToMins(b.toTime))
    );
    if (isBlocked) {
      slots.push({ time: minsToTime(start), endTime: minsToTime(end), available: false, limited: false, blocked: true });
      continue;
    }
    const overlapCount = bookings.filter(b =>
      overlaps(start, end, timeToMins(b.startTime) - TRAVEL_BUFFER, timeToMins(b.endTime) + TRAVEL_BUFFER)
    ).length;
    const available = overlapCount < MAX_SIMULTANEOUS;
    const limited = overlapCount === MAX_SIMULTANEOUS - 1 && MAX_SIMULTANEOUS > 1;
    slots.push({ time: minsToTime(start), endTime: minsToTime(end), available, limited });
  }

  res.json({ date, closed: false, slots });
});

// GET /api/holidays?year=YYYY&month=MM
app.get('/api/holidays', (req, res) => {
  const year = parseInt(req.query.year);
  const month = parseInt(req.query.month);
  const holidays = [], closedDays = [];
  for (const d of HOLIDAYS) {
    const [y, m] = d.split('-').map(Number);
    if (y === year && m === month) holidays.push(d);
  }
  for (const d of loadClosedDays()) {
    const [y, m] = d.split('-').map(Number);
    if (y === year && m === month) closedDays.push(d);
  }
  res.json({ holidays, closedDays, closedWeekday: CLOSED_WEEKDAY });
});

// GET /api/services
app.get('/api/services', (req, res) => {
  res.json(SERVICES);
});

// POST /api/book
app.post('/api/book', async (req, res) => {
  const { date, startTime, serviceId, name, phone, email, address, notes, source } = req.body;

  if (!date || !startTime || !serviceId || !name || !phone || !address) {
    return res.status(400).json({ error: '必須項目を入力してください（住所は必須です）' });
  }
  const svc = SERVICES[serviceId];
  if (!svc) return res.status(400).json({ error: '無効なサービスです' });
  if (isClosedDay(date)) return res.status(400).json({ error: '定休日・祝日・臨時休業日は予約できません' });

  const startMins = timeToMins(startTime);
  const endMins = startMins + svc.duration;
  if (startMins < OPEN_HOUR || endMins > CLOSE_HOUR) {
    return res.status(400).json({ error: `営業時間外です（${minsToTime(OPEN_HOUR)}〜${minsToTime(CLOSE_HOUR)}）` });
  }

  if (!source || source === 'web') {
    const blocked = loadBlockedSlots().filter(b => b.date === date);
    if (blocked.some(b => overlaps(startMins, endMins, timeToMins(b.fromTime), timeToMins(b.toTime)))) {
      return res.status(409).json({ error: 'この時間帯はオンライン予約を受け付けていません' });
    }
  }

  const bookings = loadBookings();
  const bufferMins = (!source || source === 'web') ? TRAVEL_BUFFER : 0;
  const overlapCount = bookings.filter(b =>
    b.date === date && overlaps(startMins, endMins, timeToMins(b.startTime) - bufferMins, timeToMins(b.endTime) + bufferMins)
  ).length;
  if (overlapCount >= MAX_SIMULTANEOUS) {
    return res.status(409).json({ error: 'この時間帯はすでに予約済みです' });
  }

  const { paymentMethod } = req.body;
  const endTime = minsToTime(endMins);
  const booking = {
    id: uuidv4(),
    date, startTime, endTime,
    serviceId, serviceName: svc.name, price: svc.price, duration: svc.duration,
    name, phone, email: email || '', address: address || '', notes: notes || '',
    paymentMethod: paymentMethod || 'cash',
    source: source || 'web',
    createdAt: new Date().toISOString(),
  };
  bookings.push(booking);
  saveBookings(bookings);

  // メール送信
  if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
      });
      const td = `border:1px solid #ddd;padding:10px 14px;`;
      const th = `${td}background:#f0f7ff;`;
      const rows = `
        <tr><td style="${th}">日付</td><td style="${td}">${date}</td></tr>
        <tr><td style="${th}">時間</td><td style="${td}">${startTime}〜${endTime}</td></tr>
        <tr><td style="${th}">サービス</td><td style="${td}">${svc.name}</td></tr>
        <tr><td style="${th}">料金</td><td style="${td}">¥${svc.price.toLocaleString()}（税込）</td></tr>
      `;
      if (email) await transporter.sendMail({
        from: `${BUSINESS_NAME} <${process.env.GMAIL_USER}>`,
        to: email,
        subject: `【${BUSINESS_NAME}】ご予約を承りました`,
        html: `<div style="font-family:sans-serif;max-width:560px;color:#333;line-height:1.8">
          <h2 style="color:#1e7fcb">ご予約ありがとうございます</h2>
          <p>${name} 様</p><p>以下の内容でご予約を承りました。</p>
          <table style="border-collapse:collapse;width:100%;margin:16px 0">${rows}</table>
          <p>ご不明な点はお気軽にお問い合わせください。</p>
          <p style="color:#666;font-size:0.9em">${BUSINESS_NAME} / TEL: ${BUSINESS_PHONE}</p>
        </div>`,
      });
      await transporter.sendMail({
        from: `${BUSINESS_NAME}予約 <${process.env.GMAIL_USER}>`,
        to: process.env.GMAIL_USER,
        subject: `【新規予約】${date} ${startTime}〜 ${name}様`,
        html: `<div style="font-family:sans-serif;max-width:560px;color:#333;line-height:1.8">
          <h2>新規予約が入りました</h2>
          <table style="border-collapse:collapse;width:100%;margin:16px 0">
            <tr><td style="${th}">お名前</td><td style="${td}">${name}</td></tr>
            <tr><td style="${th}">電話番号</td><td style="${td}">${phone}</td></tr>
            <tr><td style="${th}">メール</td><td style="${td}">${email||'なし'}</td></tr>
            <tr><td style="${th}">住所</td><td style="${td}">${address||'なし'}</td></tr>
            ${rows}
            <tr><td style="${th}">備考</td><td style="${td}">${notes||'なし'}</td></tr>
          </table>
        </div>`,
      });
    } catch (err) { console.error('メール送信エラー:', err.message); }
  }

  res.json({ success: true, booking });
});

// PUT /api/admin/booking/:id
app.put('/api/admin/booking/:id', (req, res) => {
  const { date, startTime, serviceId } = req.body;
  if (!date || !startTime || !serviceId) return res.status(400).json({ error: '必須項目を入力してください' });
  const svc = SERVICES[serviceId];
  if (!svc) return res.status(400).json({ error: '無効なサービスです' });
  if (isClosedDay(date)) return res.status(400).json({ error: '定休日・祝日・臨時休業日は予約できません' });

  const startMins = timeToMins(startTime);
  const endMins = startMins + svc.duration;
  if (startMins < OPEN_HOUR || endMins > CLOSE_HOUR) {
    return res.status(400).json({ error: `営業時間外です（${minsToTime(OPEN_HOUR)}〜${minsToTime(CLOSE_HOUR)}）` });
  }
  const bookings = loadBookings();
  const idx = bookings.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '予約が見つかりません' });

  const others = bookings.filter(b => b.date === date && b.id !== req.params.id);
  const overlapCount = others.filter(b =>
    overlaps(startMins, endMins, timeToMins(b.startTime), timeToMins(b.endTime))
  ).length;
  if (overlapCount >= MAX_SIMULTANEOUS) return res.status(409).json({ error: 'この時間帯はすでに予約済みです' });

  const endTime = minsToTime(endMins);
  bookings[idx] = { ...bookings[idx], date, startTime, endTime, serviceId, serviceName: svc.name, price: svc.price, duration: svc.duration };
  saveBookings(bookings);
  res.json({ success: true, booking: bookings[idx] });
});

// DELETE /api/admin/cancel/:id
app.delete('/api/admin/cancel/:id', (req, res) => {
  const bookings = loadBookings();
  const idx = bookings.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '予約が見つかりません' });
  bookings.splice(idx, 1);
  saveBookings(bookings);
  res.json({ success: true });
});

// POST /api/admin/booking/:id/complete
app.post('/api/admin/booking/:id/complete', (req, res) => {
  const bookings = loadBookings();
  const idx = bookings.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '予約が見つかりません' });
  bookings[idx].status = 'completed';
  bookings[idx].completedAt = new Date().toISOString();
  saveBookings(bookings);
  res.json({ success: true });
});

// GET /admin/customers
app.get('/admin/customers', (req, res) => {
  const bookings = loadBookings();
  const completed = bookings.filter(b => b.status === 'completed');

  const map = {};
  for (const b of completed) {
    const key = b.phone || b.name;
    if (!map[key]) map[key] = { name: b.name, phone: b.phone || '—', address: b.address || '—', bookings: [] };
    map[key].bookings.push(b);
    map[key].name = b.name;
    if (b.address) map[key].address = b.address;
  }

  const customers = Object.values(map).sort((a, b) => {
    const aLast = a.bookings[a.bookings.length - 1].date;
    const bLast = b.bookings[b.bookings.length - 1].date;
    return bLast.localeCompare(aLast);
  });

  let rows = '';
  for (const c of customers) {
    const total = c.bookings.reduce((s, b) => s + (b.price || 0), 0);
    const sorted = c.bookings.slice().sort((a, b) => b.date.localeCompare(a.date));
    const lastDate = sorted[0].date;
    let historyRows = '';
    for (const b of sorted) {
      historyRows += '<tr style="font-size:0.8rem">'
        + '<td style="padding:4px 8px">' + b.date + '</td>'
        + '<td style="padding:4px 8px">' + b.startTime + '〜' + b.endTime + '</td>'
        + '<td style="padding:4px 8px">' + (b.serviceName || '—') + '</td>'
        + '<td style="padding:4px 8px">¥' + (b.price || 0).toLocaleString() + '</td>'
        + '</tr>';
    }
    rows += '<div class="cust-card" onclick="this.querySelector(\'.cust-history\').classList.toggle(\'open\')">'
      + '<div class="cust-header">'
      + '<div class="cust-name">' + c.name + ' 様</div>'
      + '<div class="cust-meta">' + c.phone + ' ／ ' + c.address + '</div>'
      + '</div>'
      + '<div class="cust-stats">'
      + '<span class="cust-stat">利用 <b>' + c.bookings.length + '回</b></span>'
      + '<span class="cust-stat">合計 <b>¥' + total.toLocaleString() + '</b></span>'
      + '<span class="cust-stat">最終 <b>' + lastDate + '</b></span>'
      + '</div>'
      + '<div class="cust-history">'
      + '<table style="width:100%;border-collapse:collapse;margin-top:8px">'
      + '<thead><tr style="font-size:0.75rem;color:#888">'
      + '<th style="padding:4px 8px;text-align:left">日付</th>'
      + '<th style="padding:4px 8px;text-align:left">時間</th>'
      + '<th style="padding:4px 8px;text-align:left">サービス</th>'
      + '<th style="padding:4px 8px;text-align:left">料金</th>'
      + '</tr></thead>'
      + '<tbody>' + historyRows + '</tbody>'
      + '</table></div></div>';
  }

  const body = customers.length === 0
    ? '<div class="empty">完了済みの予約がまだありません。<br>予約を完了にすると顧客リストに反映されます。</div>'
    : '<p style="font-size:0.85rem;color:#888;margin-bottom:16px">顧客数：' + customers.length + '名（クリックで利用履歴を展開）</p>' + rows;

  res.send('<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>顧客リスト — ' + BUSINESS_NAME + '</title>'
    + '<style>'
    + '*{box-sizing:border-box;}'
    + 'body{font-family:\'Hiragino Sans\',sans-serif;margin:0;padding:24px;background:#f0f6fc;color:#333;}'
    + 'h1{font-size:1.3rem;color:#155fa0;margin:0 0 6px;}'
    + '.back-link{display:inline-block;margin-bottom:20px;color:#1e7fcb;font-size:0.85rem;text-decoration:none;}'
    + '.back-link:hover{text-decoration:underline;}'
    + '.cust-card{background:#fff;border-radius:10px;box-shadow:0 1px 6px rgba(30,127,203,.1);padding:16px 20px;margin-bottom:14px;cursor:pointer;transition:box-shadow .15s;}'
    + '.cust-card:hover{box-shadow:0 3px 12px rgba(30,127,203,.18);}'
    + '.cust-header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;}'
    + '.cust-name{font-size:1.05rem;font-weight:700;color:#155fa0;}'
    + '.cust-meta{font-size:0.82rem;color:#777;}'
    + '.cust-stats{display:flex;gap:16px;margin-top:8px;flex-wrap:wrap;}'
    + '.cust-stat{font-size:0.82rem;color:#555;background:#f0f7ff;padding:3px 10px;border-radius:20px;}'
    + '.cust-stat b{color:#1e7fcb;}'
    + '.cust-history{display:none;border-top:1px solid #e8f0f8;margin-top:10px;padding-top:8px;}'
    + '.cust-history.open{display:block;}'
    + '.empty{text-align:center;padding:40px;color:#aaa;font-size:0.9rem;}'
    + '</style></head><body>'
    + '<h1>👥 顧客リスト</h1>'
    + '<a class="back-link" href="/admin">← 管理画面に戻る</a>'
    + body
    + '</body></html>');
});

// GET /api/admin/calendar?year=YYYY&month=MM
app.get('/api/admin/calendar', (req, res) => {
  const year = parseInt(req.query.year);
  const month = parseInt(req.query.month);
  const prefix = `${year}-${String(month).padStart(2,'0')}`;
  const byDate = {};
  loadBookings().filter(b => b.date.startsWith(prefix)).forEach(b => {
    if (!byDate[b.date]) byDate[b.date] = [];
    byDate[b.date].push(b);
  });
  res.json({ year, month, byDate });
});

// GET /api/admin/closed-days
app.get('/api/admin/closed-days', (req, res) => {
  res.json({ closedDays: [...loadClosedDays()].sort() });
});

// POST /api/admin/closed-days
app.post('/api/admin/closed-days', (req, res) => {
  const { date, reason } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日付が不正です' });
  const existing = loadBookings().filter(b => b.date === date);
  if (existing.length > 0) {
    const names = existing.map(b => `${b.startTime} ${b.name}様`).join('、');
    return res.status(409).json({ error: `この日はすでに予約が入っています。\n（${names}）` });
  }
  const set = loadClosedDays();
  if (set.has(date)) return res.status(400).json({ error: 'すでに登録済みです' });
  set.add(date);
  saveClosedDays(set);
  if (reason) {
    const rf = path.join(__dirname, 'data', 'closed-days-reasons.json');
    const reasons = fs.existsSync(rf) ? JSON.parse(fs.readFileSync(rf, 'utf8')) : {};
    reasons[date] = reason;
    fs.writeFileSync(rf, JSON.stringify(reasons, null, 2));
  }
  res.json({ success: true });
});

// DELETE /api/admin/closed-days/:date
app.delete('/api/admin/closed-days/:date', (req, res) => {
  const set = loadClosedDays();
  if (!set.has(req.params.date)) return res.status(404).json({ error: '登録されていません' });
  set.delete(req.params.date);
  saveClosedDays(set);
  const rf = path.join(__dirname, 'data', 'closed-days-reasons.json');
  if (fs.existsSync(rf)) {
    const reasons = JSON.parse(fs.readFileSync(rf, 'utf8'));
    delete reasons[req.params.date];
    fs.writeFileSync(rf, JSON.stringify(reasons, null, 2));
  }
  res.json({ success: true });
});

// GET /api/admin/blocked-slots
app.get('/api/admin/blocked-slots', (req, res) => {
  res.json({ blocks: loadBlockedSlots() });
});

// POST /api/admin/blocked-slots
app.post('/api/admin/blocked-slots', (req, res) => {
  const { date, fromTime, toTime, reason } = req.body;
  if (!date || !fromTime || !toTime) return res.status(400).json({ error: '日付・開始時刻・終了時刻は必須です' });
  const from = timeToMins(fromTime), to = timeToMins(toTime);
  if (from >= to) return res.status(400).json({ error: '終了時刻は開始時刻より後にしてください' });
  if (from < OPEN_HOUR || to > CLOSE_HOUR) return res.status(400).json({ error: `営業時間（${minsToTime(OPEN_HOUR)}〜${minsToTime(CLOSE_HOUR)}）内で設定してください` });

  const conflicting = loadBookings().filter(b => {
    if (b.date !== date) return false;
    return overlaps(from, to, timeToMins(b.startTime), timeToMins(b.endTime));
  });
  if (conflicting.length > 0) {
    const names = conflicting.map(b => `${b.startTime}〜${b.endTime} ${b.name}様`).join('、');
    return res.status(409).json({ error: `この時間帯にすでに予約があります（${names}）。重複しているため設定できません。` });
  }

  const list = loadBlockedSlots();
  const id = uuidv4();
  list.push({ id, date, fromTime, toTime, reason: reason || '', createdAt: new Date().toISOString() });
  saveBlockedSlots(list);
  res.json({ success: true, id });
});

// DELETE /api/admin/blocked-slots/:id
app.delete('/api/admin/blocked-slots/:id', (req, res) => {
  const list = loadBlockedSlots();
  const idx = list.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '見つかりません' });
  list.splice(idx, 1);
  saveBlockedSlots(list);
  res.json({ success: true });
});

// ===== 管理画面 /admin =====
app.get('/admin', (req, res) => {
  const bookings = loadBookings();
  const today = new Date().toISOString().split('T')[0];
  const upcoming = bookings
    .filter(b => b.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

  const WD = ['日','月','火','水','木','金','土'];

  const srcBadge = s => s === 'phone' ? '<span class="badge badge-phone">📞 電話</span>'
                      :                 '<span class="badge badge-web">🌐 Web</span>';
  const payBadge = p => p === 'paypay'  ? '<span class="badge badge-paypay">PayPay</span>'
                      : p === 'credit'  ? '<span class="badge badge-credit">💳 カード</span>'
                      :                   '<span class="badge badge-cash">💴 現金</span>';
  const srcRowClass = s => s === 'phone' ? 'phone-row' : '';

  const rows = upcoming.length
    ? upcoming.map(b => {
        const isDone = b.status === 'completed';
        return `
        <tr class="${srcRowClass(b.source)}${isDone ? ' completed-row' : ''}">
          <td data-label="日付">${b.date}</td>
          <td data-label="時間">${b.startTime}〜${b.endTime}</td>
          <td data-label="お名前">${b.name}</td>
          <td data-label="電話番号">${b.phone || '—'}</td>
          <td data-label="住所" style="max-width:160px;word-break:break-all;font-size:0.82rem">${b.address || '—'}</td>
          <td data-label="サービス">${b.serviceName || b.menu || '—'}</td>
          <td data-label="料金">¥${(b.price||0).toLocaleString()}</td>
          <td data-label="経路">${srcBadge(b.source)}</td>
          <td data-label="支払い">${payBadge(b.paymentMethod)}</td>
          <td data-label="操作" style="white-space:nowrap">
            ${isDone ? '<span style="font-size:0.75rem;color:#2e7d32;font-weight:600;">✅ 完了済</span>' : `
            <button onclick="completeBooking('${b.id}')" class="complete-btn">✅ 完了</button>
            <button onclick="editBooking('${b.id}','${b.date}','${b.startTime}','${b.serviceId || ''}')" class="edit-btn" style="margin-left:4px">✏️ 編集</button>
            <button onclick="cancel('${b.id}')" class="cancel-btn" style="margin-left:4px">✕ キャンセル</button>`}
          </td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="10" style="text-align:center;padding:20px;color:#999">予約はありません</td></tr>';

  // 時間オプション（30分刻み）
  const timeOptions = [];
  for (let m = OPEN_HOUR; m < CLOSE_HOUR; m += 30) timeOptions.push(minsToTime(m));
  const timeOptionsHtml = timeOptions.map(t => `<option value="${t}">${t}</option>`).join('');

  // サービスオプション
  const svcOptionsHtml = Object.entries(SERVICES).map(([id, s]) =>
    `<option value="${id}">${s.name}（¥${s.price.toLocaleString()}・約${Math.floor(s.duration/60)}時間${s.duration%60?s.duration%60+'分':''}）</option>`
  ).join('');

  // 受付停止スロット一覧
  const blockedArr = loadBlockedSlots().sort((a, b) => a.date.localeCompare(b.date) || a.fromTime.localeCompare(b.fromTime));
  const blockedListHtml = blockedArr.length === 0
    ? '<p style="color:#aaa;font-size:0.85rem;margin:0">登録されている受付停止時間帯はありません</p>'
    : blockedArr.map(b => {
        const [y, mo, d] = b.date.split('-');
        const dow = new Date(b.date+'T00:00:00').getDay();
        const lbl = `${parseInt(y)}年${parseInt(mo)}月${parseInt(d)}日（${WD[dow]}）`;
        return `<div class="bs-item">
          <span class="bs-date">${lbl}</span>
          <span class="bs-time">${b.fromTime}〜${b.toTime}</span>
          ${b.reason ? `<span class="bs-reason">${b.reason}</span>` : ''}
          <button class="bs-del-btn" onclick="deleteBlockedSlot('${b.id}')">✕ 解除</button>
        </div>`;
      }).join('');

  const rf = path.join(__dirname, 'data', 'closed-days-reasons.json');
  const closedReasons = fs.existsSync(rf) ? JSON.parse(fs.readFileSync(rf, 'utf8')) : {};
  const closedDaysArr = [...loadClosedDays()].sort();
  const closedListHtml = closedDaysArr.length === 0
    ? '<p style="color:#aaa;font-size:0.85rem;margin:0">登録されている臨時休業日はありません</p>'
    : closedDaysArr.map(d => {
        const [y, mo, day] = d.split('-');
        const dow = new Date(d+'T00:00:00').getDay();
        const lbl = `${parseInt(y)}年${parseInt(mo)}月${parseInt(day)}日（${WD[dow]}）`;
        const reason = closedReasons[d] ? `<span style="font-size:0.78rem;color:#888;margin-left:8px">${closedReasons[d]}</span>` : '';
        return `<div class="cd-item"><span class="cd-date">${lbl}</span>${reason}<button class="cd-del-btn" onclick="deleteClosedDay('${d}')">✕ 解除</button></div>`;
      }).join('');

  const holidaysJson   = JSON.stringify([...HOLIDAYS]);
  const closedDaysJson = JSON.stringify(closedDaysArr);
  const closedReasonsJson = JSON.stringify(closedReasons);
  const blockedJson    = JSON.stringify(blockedArr);
  const allBookingsJson = JSON.stringify(upcoming.map(b => ({
    id: b.id, date: b.date, startTime: b.startTime, endTime: b.endTime,
    name: b.name, serviceName: b.serviceName, createdAt: b.createdAt || ''
  })));

  res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>予約管理 — ${BUSINESS_NAME}</title>
  <style>
    *{box-sizing:border-box;}
    body{font-family:'Hiragino Sans',sans-serif;margin:0;padding:24px;color:#333;background:#f0f6fc;}
    h1{font-size:1.3rem;margin:0 0 20px;color:#155fa0;}
    h2{font-size:1.05rem;margin:0 0 14px;color:#155fa0;}

    .cal-box,.form-box{background:#fff;border-radius:10px;box-shadow:0 1px 6px rgba(30,127,203,.08);padding:22px 26px 18px;margin-bottom:24px;}
    .cal-header{display:flex;align-items:center;gap:12px;margin-bottom:14px;}
    .cal-header h2{margin:0;}
    .cal-nav-btn{background:none;border:1.5px solid #ddd;border-radius:6px;width:32px;height:32px;font-size:1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s;}
    .cal-nav-btn:hover{background:#e8f4ff;}
    #calMonthLabel{font-size:1.1rem;font-weight:700;color:#155fa0;min-width:100px;}
    .cal-nav-group{display:flex;gap:6px;margin-left:auto;}

    .acal-weekdays{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:3px;}
    .acal-wd{text-align:center;font-size:0.75rem;font-weight:700;color:#999;padding:3px 0;}
    .acal-wd:nth-child(1){color:#c04040;}
    .acal-wd:nth-child(7){color:#4060c0;}

    #adminCalGrid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;}
    .acal-day{min-height:62px;border-radius:7px;padding:5px 6px 4px;background:#f5f8fc;border:1.5px solid transparent;transition:border-color .15s,background .15s;position:relative;}
    .acal-day.empty{background:transparent;}
    .acal-day.acal-closed{background:#f1f1ee;}
    .acal-day.acal-today{border-color:#1e7fcb!important;}
    .acal-day.acal-selected{background:#e8f4ff;border-color:#1e7fcb!important;}
    .acal-day.acal-has-booking{cursor:pointer;}
    .acal-day.acal-has-booking:not(.acal-selected):hover{background:#deeef9;border-color:#90c8ef;}
    .acal-day:not(.acal-has-booking):not(.acal-closed):not(.empty){cursor:pointer;}
    .acal-day:not(.acal-has-booking):not(.acal-closed):not(.empty):not(.acal-selected):hover{border-color:#ddd;}
    .acal-num{font-size:0.82rem;font-weight:500;color:#444;display:block;margin-bottom:3px;}
    .acal-day.acal-closed .acal-num{color:#ccc;}
    .acal-day.acal-sun .acal-num,.acal-day.acal-holiday .acal-num{color:#c04040;}
    .acal-day.acal-sat .acal-num{color:#4060c0;}
    .acal-day.acal-today .acal-num{font-weight:800;}
    .acal-day.acal-temp-closed{background:#fff3f3;border:1.5px solid #f5c0c0!important;}
    .acal-day.acal-temp-closed .acal-num{color:#c04040;}
    .acal-temp-badge{display:block;font-size:0.6rem;font-weight:700;color:#c04040;background:#ffe5e5;border-radius:3px;padding:1px 3px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}
    .acal-dots{display:flex;flex-wrap:wrap;gap:3px;margin-top:2px;}
    .acal-dot{width:7px;height:7px;border-radius:50%;background:#1e7fcb;}
    .acal-dot.dot-phone{background:#d4860a;}
    .acal-count{font-size:0.7rem;color:#fff;background:#1e7fcb;border-radius:50px;padding:1px 6px;display:inline-block;margin-top:3px;}

    /* 選択日の予約リスト */
    .day-detail{margin-top:16px;display:none;}
    .day-detail.open{display:block;}
    .day-detail h3{font-size:0.95rem;color:#155fa0;margin:0 0 10px;}
    .bk-card{background:#f0f7ff;border:1px solid #c5dff5;border-radius:8px;padding:12px 14px;margin-bottom:8px;position:relative;}
    .bk-card.completed{background:#f5f5f5;border-color:#ddd;opacity:0.65;}
    .bk-card.completed .bk-time{color:#999;text-decoration:line-through;}
    .bk-time{font-weight:700;font-size:1rem;color:#1e7fcb;margin-bottom:4px;}
    .bk-info{font-size:0.82rem;color:#555;line-height:1.7;}
    .bk-btns{position:absolute;top:10px;right:10px;display:flex;gap:6px;}
    .bk-cancel{background:none;border:1px solid #f5a0a0;color:#c04040;border-radius:5px;padding:3px 10px;font-size:0.75rem;cursor:pointer;transition:background .15s;}
    .bk-cancel:hover{background:#fff0f0;}
    .bk-edit{background:none;border:1px solid #a0c0f5;color:#1e7fcb;border-radius:5px;padding:3px 10px;font-size:0.75rem;cursor:pointer;transition:background .15s;}
    .bk-edit:hover{background:#e8f4ff;}
    .bk-complete{background:none;border:1px solid #81c784;color:#2e7d32;border-radius:5px;padding:3px 10px;font-size:0.75rem;cursor:pointer;transition:background .15s;}
    .bk-complete:hover{background:#e8f5e9;}
    .complete-btn{background:none;border:1px solid #81c784;color:#2e7d32;border-radius:5px;padding:3px 10px;font-size:0.75rem;cursor:pointer;white-space:nowrap;}
    .complete-btn:hover{background:#e8f5e9;}
    tr.completed-row td{background:#f5f5f5;color:#aaa;text-decoration:line-through;}

    /* フォームボックス */
    .form-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px 14px;margin-bottom:14px;}
    .form-grid label{display:flex;flex-direction:column;font-size:0.78rem;color:#888;gap:3px;min-width:0;}
    .form-grid select,.form-grid input{padding:7px 9px;border:1.5px solid #d1e4f5;border-radius:6px;font-size:0.85rem;color:#333;background:#fff;transition:border-color .15s;width:100%;max-width:100%;box-sizing:border-box;min-width:0;}
    .form-grid select:focus,.form-grid input:focus{outline:none;border-color:#1e7fcb;}
    .form-grid select.wide,.form-grid input.wide{grid-column:1/-1;}
    .reg-btn{padding:9px 22px;border:none;border-radius:7px;font-size:0.88rem;font-weight:600;cursor:pointer;transition:background .15s;}
    .reg-btn.green{background:#1e7fcb;color:#fff;}
    .reg-btn.green:hover{background:#155fa0;}
    .reg-btn.purple{background:#7c3aed;color:#fff;}
    .reg-btn.purple:hover{background:#6d28d9;}

    /* 受付停止・臨時休業 */
    .section-sub{background:#fff;border-radius:10px;box-shadow:0 1px 6px rgba(30,127,203,.08);padding:20px 24px;margin-bottom:20px;}
    .bs-item,.cd-item{display:flex;align-items:center;gap:10px;padding:8px 10px;background:#f8fbff;border-radius:6px;margin-bottom:6px;flex-wrap:wrap;}
    .bs-date,.cd-date{font-weight:600;font-size:0.85rem;}
    .bs-time{font-size:0.82rem;color:#555;background:#e8f4ff;padding:2px 8px;border-radius:4px;}
    .bs-reason,.cd-reason{font-size:0.78rem;color:#888;}
    .bs-del-btn,.cd-del-btn{margin-left:auto;background:none;border:1px solid #f5a0a0;color:#c04040;border-radius:5px;padding:3px 10px;font-size:0.75rem;cursor:pointer;}
    .bs-del-btn:hover,.cd-del-btn:hover{background:#fff0f0;}

    /* 予約一覧テーブル */
    .table-wrap{overflow-x:auto;}
    table{width:100%;border-collapse:collapse;font-size:0.83rem;}
    th{background:#e8f4ff;padding:9px 10px;text-align:left;font-weight:600;color:#155fa0;white-space:nowrap;border-bottom:2px solid #c5dff5;}
    td{padding:9px 10px;border-bottom:1px solid #e8f0f8;vertical-align:top;}
    tr.phone-row td{background:#fffbf0;}
    tr:hover td{background:#f0f7ff;}
    .badge{display:inline-block;padding:2px 8px;border-radius:50px;font-size:0.72rem;font-weight:600;}
    .badge-web{background:#e0f0ff;color:#1e7fcb;}
    .badge-phone{background:#fff3d0;color:#b07800;}
    .badge-cash{background:#e8f5e9;color:#2e7d32;}
    .badge-paypay{background:#fff0f0;color:#c0392b;}
    .badge-credit{background:#f3e5f5;color:#6a1b9a;}
    .cancel-btn{background:none;border:1px solid #f5a0a0;color:#c04040;border-radius:5px;padding:3px 10px;font-size:0.75rem;cursor:pointer;white-space:nowrap;}
    .cancel-btn:hover{background:#fff0f0;}
    .edit-btn{background:none;border:1px solid #a0c0f5;color:#1e7fcb;border-radius:5px;padding:3px 10px;font-size:0.75rem;cursor:pointer;white-space:nowrap;}
    .edit-btn:hover{background:#e8f4ff;}

    /* 編集モーダル */
    .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9000;align-items:center;justify-content:center;}
    .modal-overlay.open{display:flex;}
    .modal-box{background:#fff;border-radius:12px;padding:28px 28px 22px;width:90%;max-width:460px;box-shadow:0 8px 32px rgba(0,0,0,0.18);}
    .modal-title{font-size:1.05rem;font-weight:700;color:#155fa0;margin:0 0 18px;}
    .modal-field{display:flex;flex-direction:column;gap:4px;margin-bottom:12px;font-size:0.82rem;color:#888;}
    .modal-field input,.modal-field select{padding:8px 10px;border:1.5px solid #d1e4f5;border-radius:7px;font-size:0.9rem;color:#333;background:#fff;width:100%;}
    .modal-field input:focus,.modal-field select:focus{outline:none;border-color:#1e7fcb;}
    .modal-btns{display:flex;gap:10px;justify-content:flex-end;margin-top:18px;}
    .modal-save-btn{padding:9px 22px;background:#1e7fcb;color:#fff;border:none;border-radius:7px;font-size:0.88rem;font-weight:600;cursor:pointer;}
    .modal-save-btn:hover{background:#155fa0;}
    .modal-cancel-btn{padding:9px 18px;background:none;border:1.5px solid #ddd;color:#666;border-radius:7px;font-size:0.88rem;cursor:pointer;}
    .modal-cancel-btn:hover{background:#f5f5f5;}

    /* デイリータイムライン */
    .day-timeline{margin-top:18px;display:none;}
    .day-timeline.open{display:block;}
    .tl-header{font-size:0.95rem;font-weight:700;color:#155fa0;margin:0 0 10px;}
    .tl-outer{border:1px solid #dde8f5;border-radius:8px;overflow:hidden;background:#fafcff;}
    .tl-wrap{display:flex;}
    .tl-hours{width:46px;flex-shrink:0;background:#f3f7fc;border-right:1px solid #e0eaf5;}
    .tl-hour-cell{height:60px;font-size:0.72rem;color:#888;padding:4px 6px 0;line-height:1;}
    .tl-lane{flex:1;position:relative;}
    .tl-lane-bg{pointer-events:none;}
    .tl-lane-hr{height:60px;border-bottom:1px solid #eef2f8;}
    .tl-lane-hr:last-child{border-bottom:none;}
    .tl-bars{position:absolute;top:0;left:0;right:0;}
    .tl-bar{position:absolute;left:3px;right:3px;border-radius:5px;overflow:hidden;display:flex;align-items:center;padding:0 8px;font-size:0.73rem;font-weight:600;color:#fff;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.12);}
    .tl-bar.src-web{background:#2e7d32;}
    .tl-bar.src-phone{background:#a0522d;}
    .tl-bar.src-walkin{background:#1b5e20;}
    .tl-bar.src-blocked{background:repeating-linear-gradient(45deg,#f0c030 0,#f0c030 6px,#fffbe5 6px,#fffbe5 12px);color:#6a4f00;border:1px solid #e0b020;}
    .tl-empty{text-align:center;padding:24px;color:#aaa;font-size:0.85rem;}
    .tl-legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:0.73rem;color:#555;}
    .tl-legend-item{display:flex;align-items:center;gap:5px;}
    .tl-legend-color{width:14px;height:12px;border-radius:3px;flex-shrink:0;}

    /* 新着通知バナー */
    #notifArea{margin-bottom:20px;width:100%;box-sizing:border-box;}
    .notif-banner{display:flex;align-items:flex-start;gap:10px;background:#fff8e1;border:2px solid #f9a825;border-radius:10px;padding:14px 14px;margin-bottom:10px;cursor:pointer;transition:background .15s;box-shadow:0 2px 8px rgba(249,168,37,.2);width:100%;box-sizing:border-box;}
    .notif-banner:hover{background:#fff3cd;}
    .notif-icon{font-size:1.4rem;flex-shrink:0;margin-top:2px;}
    .notif-body{flex:1;min-width:0;overflow:hidden;}
    .notif-title{font-weight:700;font-size:0.95rem;color:#e65100;}
    .notif-sub{font-size:0.8rem;color:#7f4f00;margin-top:4px;line-height:1.5;word-break:break-all;}
    .notif-arrow{font-size:1.1rem;color:#f9a825;flex-shrink:0;margin-top:2px;}
    .notif-dismiss{background:none;border:none;font-size:1.1rem;color:#aaa;cursor:pointer;padding:0 2px;flex-shrink:0;}
    .notif-dismiss:hover{color:#888;}

    /* レスポンシブ */
    @media(max-width:600px){
      body{padding:10px;overflow-x:hidden;}
      h1{font-size:1.1rem;margin-bottom:14px;}
      h2{font-size:0.95rem;}
      .cal-box,.form-box,.section-sub{padding:14px 12px;overflow:hidden;}

      /* フォームを1カラムに */
      .form-grid{grid-template-columns:1fr !important;width:100%;}
      .form-grid label{grid-column:1 !important;width:100%;min-width:0;}

      /* セレクト・インプットが画面内に収まるよう */
      .form-grid select,.form-grid input{
        font-size:1rem;
        padding:12px 10px;
        width:100% !important;
        max-width:100% !important;
        box-sizing:border-box;
        min-width:0;
      }
      .reg-btn{width:100%;padding:13px;font-size:1rem;}

      /* 予約テーブルを縦積みカードに */
      .table-wrap table thead{display:none;}
      .table-wrap table tbody tr{
        display:block;
        background:#fff;
        border:1px solid #d1e4f5;
        border-radius:8px;
        margin-bottom:10px;
        padding:10px 12px;
      }
      .table-wrap table tbody td{
        display:flex;
        justify-content:space-between;
        align-items:center;
        padding:4px 0;
        border:none;
        font-size:0.83rem;
        border-bottom:1px solid #f0f4fa;
      }
      .table-wrap table tbody td:last-child{border-bottom:none;}
      .table-wrap table tbody td::before{
        content:attr(data-label);
        font-weight:600;
        color:#888;
        font-size:0.75rem;
        flex-shrink:0;
        margin-right:8px;
      }

      /* カレンダー */
      .acal-day{min-height:48px;padding:4px 3px;}
      .acal-num{font-size:0.75rem;}
      .acal-dot{width:6px;height:6px;}

      /* タイムライン */
      .tl-bar{font-size:0.65rem;padding:0 4px;}

      /* 受付停止・休業アイテム */
      .bs-item,.cd-item{flex-direction:column;align-items:flex-start;gap:6px;}
      .bs-del-btn,.cd-del-btn{margin-left:0;width:100%;text-align:center;padding:8px;}
    }
  </style>
</head>
<body>
<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:20px;">
  <h1 style="margin:0">📋 予約管理 — ${BUSINESS_NAME}</h1>
  <a href="/admin/customers" style="background:#1e7fcb;color:#fff;padding:7px 16px;border-radius:7px;text-decoration:none;font-size:0.85rem;font-weight:600;">👥 顧客リスト</a>
</div>

<!-- 新着通知エリア -->
<div id="notifArea"></div>

<!-- 月間カレンダー -->
<div class="cal-box">
  <div class="cal-header">
    <h2>📅 月間カレンダー</h2>
    <span id="calMonthLabel"></span>
    <div class="cal-nav-group">
      <button class="cal-nav-btn" id="calPrev">‹</button>
      <button class="cal-nav-btn" id="calNext">›</button>
    </div>
  </div>
  <div class="acal-weekdays">
    <div class="acal-wd">日</div><div class="acal-wd">月</div><div class="acal-wd">火</div>
    <div class="acal-wd">水</div><div class="acal-wd">木</div><div class="acal-wd">金</div>
    <div class="acal-wd">土</div>
  </div>
  <div id="adminCalGrid"></div>
  <div class="day-detail" id="dayDetail">
    <h3 id="dayDetailTitle"></h3>
    <div id="dayDetailCards"></div>
  </div>
  <div class="day-timeline" id="dayTimeline"></div>
</div>

<!-- 電話予約 -->
<div class="form-box">
  <h2>📞 電話予約を登録する</h2>
  <div class="form-grid">
    <label>日付 *<input type="date" id="pDate" onchange="updatePhoneTimeSlots()"></label>
    <label>開始時間 *<select id="pTime">${timeOptionsHtml}</select></label>
    <label style="grid-column:1/-1">サービス *<select id="pSvc" onchange="updatePhoneTimeSlots()">${svcOptionsHtml}</select></label>
    <label>お名前 *<input type="text" id="pName" placeholder="山田 太郎"></label>
    <label>電話番号 *<input type="tel" id="pPhone" placeholder="090-0000-0000"></label>
    <label style="grid-column:1/-1">住所<input type="text" id="pAddress" placeholder="津山市〇〇 1-2-3"></label>
    <label style="grid-column:1/-1">備考<input type="text" id="pNotes" placeholder="特記事項など"></label>
  </div>
  <button class="reg-btn green" onclick="registerBooking('phone')">カレンダーに登録する</button>
</div>

<!-- 受付停止 -->
<div class="section-sub">
  <h2>🟡 オンライン受付停止の時間帯を設定する</h2>
  <div class="form-grid">
    <label>日付 *<input type="date" id="bsDate"></label>
    <label>停止開始時刻 *
      <select id="bsFrom">${timeOptionsHtml}</select>
    </label>
    <label>停止終了時刻 *
      <select id="bsTo">${timeOptionsHtml}</select>
    </label>
    <label>メモ（任意）<input type="text" id="bsMemo" placeholder="例：急用・出張"></label>
  </div>
  <button class="reg-btn green" onclick="addBlockedSlot()" style="margin-bottom:14px">+ 受付停止を設定する</button>
  <div id="blockedSlotsList">${blockedListHtml}</div>
</div>

<!-- 臨時休業 -->
<div class="section-sub">
  <h2>🔴 臨時休業日の設定</h2>
  <div class="form-grid" style="max-width:500px">
    <label>休業日 *<input type="date" id="cdDate"></label>
    <label>メモ（任意）<input type="text" id="cdMemo" placeholder="例：研修・私用"></label>
  </div>
  <button class="reg-btn green" onclick="addClosedDay()" style="margin-bottom:14px">+ 休業日に設定する</button>
  <div id="closedDaysList">${closedListHtml}</div>
</div>

<!-- 予約一覧 -->
<div class="form-box">
  <h2>📋 今後の予約一覧</h2>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>日付</th><th>時間</th><th>お名前</th><th>電話番号</th>
        <th>住所</th><th>サービス</th><th>料金</th><th>経路</th><th>支払い</th><th>操作</th>
      </tr></thead>
      <tbody id="bookingTableBody">${rows}</tbody>
    </table>
  </div>
</div>

<!-- 編集モーダル -->
<div class="modal-overlay" id="editModal" onclick="if(event.target===this)closeEditModal()">
  <div class="modal-box">
    <div class="modal-title">✏️ 予約を編集する</div>
    <input type="hidden" id="editId">
    <div class="modal-field">
      <label>日付 *</label>
      <input type="date" id="editDate" onchange="updateEditTimeSlots()">
    </div>
    <div class="modal-field">
      <label>開始時間 *</label>
      <select id="editTime"></select>
    </div>
    <div class="modal-field">
      <label>サービス *</label>
      <select id="editSvc" onchange="updateEditTimeSlots()">${svcOptionsHtml}</select>
    </div>
    <div class="modal-btns">
      <button class="modal-cancel-btn" onclick="closeEditModal()">キャンセル</button>
      <button class="modal-save-btn" onclick="saveEditBooking()">保存する</button>
    </div>
  </div>
</div>

<script>
const HOLIDAYS_SET = new Set(${holidaysJson});
let closedDays = new Set(${closedDaysJson});
const closedReasons = ${closedReasonsJson};
let blockedSlots = ${blockedJson};
const CLOSED_WEEKDAY_JS = ${CLOSED_WEEKDAY};
const OPEN_HOUR_JS  = ${OPEN_HOUR};
const CLOSE_HOUR_JS = ${CLOSE_HOUR};
const WD = ['日','月','火','水','木','金','土'];
const ALL_BOOKINGS = ${allBookingsJson};

// ===== 新着通知 =====
(function() {
  const SEEN_KEY = 'adminSeenIds';
  const seenIds = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));

  // 未確認の予約を全件通知（既読IDを除く）
  const newBks = ALL_BOOKINGS.filter(b => b.id && !seenIds.has(b.id));

  const area = document.getElementById('notifArea');
  if (newBks.length === 0) return;

  newBks.forEach(b => {
    const [y, m, d] = b.date.split('-');
    const dow = new Date(b.date + 'T00:00:00').getDay();
    const dateLabel = \`\${parseInt(y)}年\${parseInt(m)}月\${parseInt(d)}日（\${WD[dow]}）\`;
    const banner = document.createElement('div');
    banner.className = 'notif-banner';
    banner.innerHTML = \`
      <span class="notif-icon">🔔</span>
      <div class="notif-body">
        <div class="notif-title">新しい予約が入りました</div>
        <div class="notif-sub">\${dateLabel}　\${b.startTime}〜\${b.endTime}<br>\${b.name} 様　\${b.serviceName || ''}</div>
      </div>
      <span class="notif-arrow">→</span>
      <button class="notif-dismiss" title="閉じる">✕</button>
    \`;
    const markSeen = () => {
      seenIds.add(b.id);
      localStorage.setItem(SEEN_KEY, JSON.stringify([...seenIds]));
    };
    banner.querySelector('.notif-arrow').addEventListener('click', () => { markSeen(); jumpToDate(b.date); });
    banner.querySelector('.notif-body').addEventListener('click', () => { markSeen(); jumpToDate(b.date); });
    banner.querySelector('.notif-dismiss').addEventListener('click', e => { e.stopPropagation(); markSeen(); banner.remove(); });
    area.appendChild(banner);
  });
})();

function jumpToDate(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  calY = y;
  calM = m - 1;
  renderAdminCal();
  // カレンダー描画後に該当日をクリック
  setTimeout(() => {
    document.querySelectorAll('.acal-day').forEach(el => {
      if (el.dataset.date === dateStr) el.click();
    });
    document.querySelector('.cal-box')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
}

// ===== 管理カレンダー =====
let calY = new Date().getFullYear();
let calM = new Date().getMonth();
let selectedCalDate = null;
let calBookings = {};

document.getElementById('calPrev').addEventListener('click', () => { calM--; if(calM<0){calM=11;calY--;} loadCalData(); });
document.getElementById('calNext').addEventListener('click', () => { calM++; if(calM>11){calM=0;calY++;} loadCalData(); });

async function loadCalData() {
  const res = await fetch('/api/admin/calendar?year='+calY+'&month='+(calM+1));
  const data = await res.json();
  calBookings = data.byDate || {};
  renderAdminCal();
}

function renderAdminCal() {
  document.getElementById('calMonthLabel').textContent = calY + '年 ' + (calM+1) + '月';
  const grid = document.getElementById('adminCalGrid');
  grid.innerHTML = '';
  const today = new Date(); today.setHours(0,0,0,0);
  const firstDay = new Date(calY, calM, 1).getDay();
  const daysInMonth = new Date(calY, calM+1, 0).getDate();
  const prefix = calY + '-' + String(calM+1).padStart(2,'0');

  for (let i=0; i<firstDay; i++) {
    const e = document.createElement('div');
    e.className = 'acal-day empty';
    grid.appendChild(e);
  }
  for (let d=1; d<=daysInMonth; d++) {
    const dateStr = prefix+'-'+String(d).padStart(2,'0');
    const dow = new Date(dateStr+'T00:00:00').getDay();
    const isHoliday = HOLIDAYS_SET.has(dateStr);
    const isTempClosed = closedDays.has(dateStr);
    const isRegClosed = CLOSED_WEEKDAY_JS >= 0 && dow === CLOSED_WEEKDAY_JS;
    const isClosed = isRegClosed || isHoliday || isTempClosed;
    const bks = calBookings[dateStr] || [];
    const isToday = new Date(dateStr+'T00:00:00').getTime() === today.getTime();
    const isSelected = selectedCalDate === dateStr;

    const el = document.createElement('div');
    el.className = 'acal-day';
    el.dataset.date = dateStr;
    if (dow===0||isHoliday) el.classList.add('acal-sun','acal-holiday');
    if (dow===6) el.classList.add('acal-sat');
    if (isClosed && !isTempClosed) el.classList.add('acal-closed');
    if (isTempClosed) el.classList.add('acal-temp-closed');
    if (isToday) el.classList.add('acal-today');
    if (isSelected) el.classList.add('acal-selected');
    if (bks.length) el.classList.add('acal-has-booking');

    const numSpan = document.createElement('span');
    numSpan.className = 'acal-num';
    numSpan.textContent = d;
    el.appendChild(numSpan);

    if (isTempClosed) {
      const badge = document.createElement('span');
      badge.className = 'acal-temp-badge';
      badge.textContent = '🔴 ' + (closedReasons[dateStr] || '臨時休業');
      el.appendChild(badge);
    } else if (isRegClosed || isHoliday) {
      const badge = document.createElement('span');
      badge.style.cssText = 'display:block;font-size:0.6rem;color:#c04040;margin-top:2px;';
      badge.textContent = isHoliday ? '祝' : '休';
      el.appendChild(badge);
    }

    if (bks.length) {
      const dots = document.createElement('div');
      dots.className = 'acal-dots';
      bks.slice(0,5).forEach(b => {
        const dot = document.createElement('span');
        dot.className = 'acal-dot' + (b.source==='phone'?' dot-phone':'');
        dots.appendChild(dot);
      });
      if (bks.length > 5) {
        const more = document.createElement('span');
        more.className = 'acal-count';
        more.textContent = '+' + (bks.length-5);
        dots.appendChild(more);
      }
      el.appendChild(dots);
    }

    el.addEventListener('click', () => selectCalDay(dateStr, bks));
    grid.appendChild(el);
  }
}

function selectCalDay(dateStr, bks) {
  selectedCalDate = dateStr;
  renderAdminCal();
  const detail = document.getElementById('dayDetail');
  const title = document.getElementById('dayDetailTitle');
  const cards = document.getElementById('dayDetailCards');
  const [y,m,d] = dateStr.split('-');
  const dow = new Date(dateStr+'T00:00:00').getDay();
  title.textContent = parseInt(y)+'年'+parseInt(m)+'月'+parseInt(d)+'日（'+WD[dow]+'）の予約';
  if (bks.length === 0) {
    cards.innerHTML = '<p style="color:#999;font-size:0.85rem">この日の予約はありません</p>';
  } else {
    cards.innerHTML = bks.map(b => \`
      <div class="bk-card\${b.status === 'completed' ? ' completed' : ''}">
        <div class="bk-time">\${b.startTime}〜\${b.endTime}</div>
        <div class="bk-info">
          \${b.name} 様 / \${b.phone||'—'}<br>
          住所：\${b.address||'—'}<br>
          サービス：\${b.serviceName||b.menu||'—'} ¥\${(b.price||0).toLocaleString()}<br>
          \${b.notes ? '備考：'+b.notes+'<br>' : ''}
          <span style="font-size:0.75rem;color:#999">経路: \${b.source==='phone'?'電話':b.source==='walkin'?'飛び込み':'Web'}</span>
        </div>
        \${b.status === 'completed' ? '<div style="font-size:0.8rem;color:#2e7d32;font-weight:600;margin-top:6px;">✅ 完了済み</div>' : \`
        <div class="bk-btns">
          <button class="bk-complete" onclick="completeBooking('\${b.id}')">✅ 完了</button>
          <button class="bk-edit" onclick="editBooking('\${b.id}','\${b.date}','\${b.startTime}','\${b.serviceId||''}')">✏️ 編集</button>
          <button class="bk-cancel" onclick="cancel('\${b.id}')">✕ キャンセル</button>
        </div>\`}
      </div>\`).join('');
  }
  detail.classList.add('open');
  renderDayTimeline(dateStr, bks);
}

function renderDayTimeline(dateStr, bks) {
  const tl = document.getElementById('dayTimeline');
  const [y,m,d] = dateStr.split('-');
  const dow = new Date(dateStr+'T00:00:00').getDay();
  const openMin = OPEN_HOUR_JS, closeMin = CLOSE_HOUR_JS, totalMin = closeMin - openMin;
  const dayBlocked = blockedSlots.filter(b => b.date === dateStr);

  let hourCells = '', laneHrs = '';
  for (let h = Math.floor(openMin/60); h <= Math.floor((closeMin-1)/60); h++) {
    hourCells += \`<div class="tl-hour-cell">\${h}時</div>\`;
    laneHrs   += '<div class="tl-lane-hr"></div>';
  }

  const makeBars = (items) => items.map(b => {
    const isBlk = !!b.fromTime;
    const s0 = isBlk ? b.fromTime : b.startTime;
    const e0 = isBlk ? b.toTime   : b.endTime;
    const s = tlMins(s0) - openMin, e = tlMins(e0) - openMin;
    const h2 = Math.max(e - s, 18);
    if (isBlk) return \`<div class="tl-bar src-blocked" style="top:\${s}px;height:\${h2}px">受付停止　\${s0}〜\${e0}\${b.reason?' '+b.reason:''}</div>\`;
    const sc = b.source==='phone'?'src-phone':b.source==='walkin'?'src-walkin':'src-web';
    return \`<div class="tl-bar \${sc}" style="top:\${s}px;height:\${h2}px">\${s0}〜\${e0}　\${b.name}様　\${b.serviceName||''}</div>\`;
  }).join('');

  const inner = (bks.length || dayBlocked.length)
    ? \`<div class="tl-wrap">
        <div class="tl-hours">\${hourCells}</div>
        <div class="tl-lane" style="height:\${totalMin}px">
          <div class="tl-lane-bg">\${laneHrs}</div>
          <div class="tl-bars" style="height:\${totalMin}px">\${makeBars([...bks,...dayBlocked])}</div>
        </div>
       </div>\`
    : '<div class="tl-empty">この日の予約はありません</div>';

  tl.innerHTML = \`
    <h3 class="tl-header">\${parseInt(y)}年\${parseInt(m)}月\${parseInt(d)}日（\${WD[dow]}）</h3>
    <div class="tl-outer">\${inner}</div>
    <div class="tl-legend">
      <div class="tl-legend-item"><div class="tl-legend-color" style="background:#2e7d32"></div>Web予約</div>
      <div class="tl-legend-item"><div class="tl-legend-color" style="background:#a0522d"></div>電話予約</div>
      <div class="tl-legend-item"><div class="tl-legend-color" style="background:#1b5e20"></div>飛び込み</div>
      <div class="tl-legend-item"><div class="tl-legend-color" style="background:repeating-linear-gradient(45deg,#f0c030 0,#f0c030 6px,#fffbe5 6px,#fffbe5 12px);border:1px solid #e0b020"></div>受付停止</div>
    </div>\`;
  tl.classList.add('open');
}
function tlMins(t) { const [h,m] = t.split(':').map(Number); return h*60+m; }

// ===== 予約登録 =====
// ===== 編集モーダル =====
async function editBooking(id, date, startTime, serviceId) {
  document.getElementById('editId').value = id;
  document.getElementById('editDate').value = date;
  if (serviceId) document.getElementById('editSvc').value = serviceId;
  await updateEditTimeSlots(startTime);
  document.getElementById('editModal').classList.add('open');
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('open');
}

async function updateEditTimeSlots(selectTime) {
  const date = document.getElementById('editDate').value;
  const serviceId = document.getElementById('editSvc').value;
  const id = document.getElementById('editId').value;
  const sel = document.getElementById('editTime');
  const prev = selectTime || sel.value;
  if (!date || !serviceId) return;
  const res = await fetch('/api/availability?date=' + date + '&serviceId=' + serviceId);
  const data = await res.json();
  sel.innerHTML = '';
  if (data.closed || !data.slots || data.slots.length === 0) {
    sel.innerHTML = '<option value="" disabled selected>この日は予約不可</option>';
    return;
  }
  data.slots.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.time;
    if (!s.available) {
      opt.textContent = s.time + '　━━ 選択できません';
      opt.disabled = true;
      opt.style.color = '#aaa';
    } else {
      opt.textContent = s.time;
    }
    sel.appendChild(opt);
  });
  // 現在の予約時間は重複チェックから除外されているので選べるようにする
  const target = [...sel.options].find(o => o.value === prev);
  if (target) { target.disabled = false; target.textContent = target.textContent.replace('　━━ 選択できません', ''); sel.value = prev; }
  else {
    const first = [...sel.options].find(o => !o.disabled);
    if (first) sel.value = first.value;
  }
}

async function saveEditBooking() {
  const id = document.getElementById('editId').value;
  const date = document.getElementById('editDate').value;
  const startTime = document.getElementById('editTime').value;
  const serviceId = document.getElementById('editSvc').value;
  if (!date || !startTime || !serviceId) return alert('日付・時間・サービスは必須です');
  const res = await fetch('/api/admin/booking/' + id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ date, startTime, serviceId }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || '保存に失敗しました');
  alert('更新しました！');
  closeEditModal();
  location.reload();
}

async function updatePhoneTimeSlots() {
  const date = document.getElementById('pDate').value;
  const serviceId = document.getElementById('pSvc').value;
  const sel = document.getElementById('pTime');
  const prev = sel.value;
  if (!date || !serviceId) return;
  const res = await fetch('/api/availability?date=' + date + '&serviceId=' + serviceId);
  const data = await res.json();
  sel.innerHTML = '';
  if (data.closed || !data.slots || data.slots.length === 0) {
    sel.innerHTML = '<option value="" disabled selected>この日は予約不可</option>';
    return;
  }
  data.slots.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.time;
    if (!s.available) {
      opt.textContent = s.time + '　━━ 選択できません';
      opt.disabled = true;
      opt.style.color = '#aaa';
    } else {
      opt.textContent = s.time;
    }
    sel.appendChild(opt);
  });
  if ([...sel.options].some(o => !o.disabled && o.value === prev)) sel.value = prev;
  else {
    const first = [...sel.options].find(o => !o.disabled);
    if (first) sel.value = first.value;
  }
}

async function registerBooking(source) {
  const date     = document.getElementById('pDate').value;
  const startTime= document.getElementById('pTime').value;
  const serviceId= document.getElementById('pSvc').value;
  const name     = document.getElementById('pName').value.trim();
  const phone    = document.getElementById('pPhone').value.trim();
  const address  = document.getElementById('pAddress').value.trim();
  const notes    = document.getElementById('pNotes').value.trim();

  if (!date||!startTime||!serviceId||!name) return alert('日付・時間・サービス・お名前は必須です');
  if (!phone) return alert('電話番号は必須です');

  const res = await fetch('/api/book', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ date, startTime, serviceId, name, phone, address, notes, source }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || '登録に失敗しました');
  alert('登録しました！');
  loadCalData();
  location.reload();
}

// ===== 完了 =====
async function completeBooking(id) {
  if (!confirm('この予約を完了にしますか？\\n完了すると顧客リストに反映されます。')) return;
  const res = await fetch('/api/admin/booking/' + id + '/complete', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'エラーが発生しました');
  location.reload();
}

// ===== キャンセル =====
async function cancel(id) {
  if (!confirm('この予約をキャンセルしますか？')) return;
  const res = await fetch('/api/admin/cancel/'+id, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'キャンセルに失敗しました');
  alert('キャンセルしました');
  loadCalData();
  location.reload();
}

// ===== 受付停止 =====
async function addBlockedSlot() {
  const date = document.getElementById('bsDate').value;
  const fromTime = document.getElementById('bsFrom').value;
  const toTime = document.getElementById('bsTo').value;
  const reason = document.getElementById('bsMemo').value.trim();
  if (!date||!fromTime||!toTime) return alert('日付・開始時刻・終了時刻は必須です');
  const res = await fetch('/api/admin/blocked-slots', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ date, fromTime, toTime, reason }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'エラーが発生しました');
  alert('設定しました');
  location.reload();
}

async function deleteBlockedSlot(id) {
  if (!confirm('受付停止を解除しますか？')) return;
  const res = await fetch('/api/admin/blocked-slots/'+id, { method: 'DELETE' });
  if (res.ok) location.reload();
}

// ===== 臨時休業 =====
async function addClosedDay() {
  const date = document.getElementById('cdDate').value;
  const reason = document.getElementById('cdMemo').value.trim();
  if (!date) return alert('日付を入力してください');
  const res = await fetch('/api/admin/closed-days', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ date, reason }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'エラーが発生しました');
  alert('設定しました');
  location.reload();
}

async function deleteClosedDay(date) {
  if (!confirm('臨時休業を解除しますか？')) return;
  const res = await fetch('/api/admin/closed-days/'+date, { method: 'DELETE' });
  if (res.ok) location.reload();
}

// 初期化
loadCalData();
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`kaji清掃 予約システム起動中 → http://localhost:${PORT}`);
  console.log(`管理画面 → http://localhost:${PORT}/admin`);
});
