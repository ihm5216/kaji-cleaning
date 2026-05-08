/* ===== サービス定義（server.jsと同期） ===== */
const SERVICES_INFO = {
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

/* ===== 状態管理 ===== */
const state = {
  serviceId: null,
  selectedDate: null,
  selectedTime: null,
  currentYear: new Date().getFullYear(),
  currentMonth: new Date().getMonth(),
  holidayCache: {},
};

/* ===== ナビゲーション ===== */
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 40);
});

const hamburger = document.getElementById('hamburger');
const mobileMenu = document.getElementById('mobileMenu');
hamburger.addEventListener('click', () => {
  hamburger.classList.toggle('open');
  mobileMenu.classList.toggle('open');
});
mobileMenu.querySelectorAll('a').forEach(a => {
  a.addEventListener('click', () => {
    hamburger.classList.remove('open');
    mobileMenu.classList.remove('open');
  });
});

/* ===== スムーススクロール ===== */
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    const top = target.getBoundingClientRect().top + window.scrollY - 72;
    window.scrollTo({ top, behavior: 'smooth' });
  });
});

/* ===== サービスセクション「このサービスで予約」ボタン ===== */
document.querySelectorAll('.service-book-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const svcId = btn.dataset.service;
    scrollToBooking();
    setTimeout(() => selectService(svcId), 400);
  });
});

function scrollToBooking() {
  const el = document.getElementById('booking');
  const top = el.getBoundingClientRect().top + window.scrollY - 80;
  window.scrollTo({ top, behavior: 'smooth' });
}

/* ===== ステップ制御 ===== */
function goStep(n) {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById('step-' + i);
    if (el) el.classList.add('hidden');
  }
  document.getElementById('step-done').classList.add('hidden');
  const target = document.getElementById('step-' + n);
  if (target) target.classList.remove('hidden');
  updateStepsBar(n);
}

function updateStepsBar(active) {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById('si-' + i);
    if (!el) continue;
    el.classList.remove('active', 'done');
    if (i < active) el.classList.add('done');
    else if (i === active) el.classList.add('active');
  }
}

/* ===== Step1: サービス選択 ===== */
document.querySelectorAll('.bsvc-btn').forEach(btn => {
  btn.addEventListener('click', () => selectService(btn.dataset.service));
});

function selectService(svcId) {
  state.serviceId = svcId;
  state.selectedDate = null;
  state.selectedTime = null;

  document.querySelectorAll('.bsvc-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.service === svcId);
  });

  renderCalendar();
  goStep(2);
}

/* ===== Step2: カレンダー ===== */
document.getElementById('prevMonth').addEventListener('click', () => changeMonth(-1));
document.getElementById('nextMonth').addEventListener('click', () => changeMonth(1));

function changeMonth(delta) {
  state.currentMonth += delta;
  if (state.currentMonth < 0)  { state.currentMonth = 11; state.currentYear--; }
  if (state.currentMonth > 11) { state.currentMonth = 0;  state.currentYear++; }
  renderCalendar();
}

async function renderCalendar() {
  const { currentYear: y, currentMonth: m } = state;
  document.getElementById('monthLabel').textContent = `${y}年 ${m + 1}月`;

  const cacheKey = `${y}-${m + 1}`;
  if (!state.holidayCache[cacheKey]) {
    try {
      const res = await fetch(`/api/holidays?year=${y}&month=${m + 1}`);
      const data = await res.json();
      state.holidayCache[cacheKey] = {
        holidays:      new Set(data.holidays   || []),
        closedDays:    new Set(data.closedDays || []),
        closedWeekday: data.closedWeekday ?? -1,
      };
    } catch {
      state.holidayCache[cacheKey] = { holidays: new Set(), closedDays: new Set(), closedWeekday: -1 };
    }
  }
  const { holidays, closedDays: tempClosed, closedWeekday } = state.holidayCache[cacheKey];

  const grid = document.getElementById('calGrid');
  grid.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const firstDay    = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();

  for (let i = 0; i < firstDay; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-day empty';
    grid.appendChild(empty);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const date    = new Date(y, m, d);
    const dow     = date.getDay();
    const dateStr = formatDate(y, m + 1, d);
    const isPast        = date < today;
    const isHoliday     = holidays.has(dateStr);
    const isTempClose   = tempClosed.has(dateStr);
    const isRegClosed   = closedWeekday >= 0 && dow === closedWeekday;
    const isAnyClosed   = isHoliday || isTempClose || isRegClosed;
    const isSelected    = state.selectedDate === dateStr;

    const el = document.createElement('div');
    el.className = 'cal-day';
    if (dow === 0 || isHoliday) el.classList.add('sunday');
    if (dow === 6) el.classList.add('saturday');

    const numSpan = document.createElement('span');
    numSpan.textContent = d;
    el.appendChild(numSpan);

    if (!isPast && isAnyClosed) {
      const lbl = document.createElement('span');
      lbl.textContent = isHoliday ? '祝' : isRegClosed ? '休' : '臨';
      lbl.style.cssText = 'display:block;font-size:0.58rem;line-height:1;margin-top:1px;opacity:0.75;';
      el.appendChild(lbl);
    }

    if (isPast) {
      el.classList.add('past');
    } else if (isAnyClosed) {
      el.classList.add('closed');
      el.title = isHoliday ? '祝日のため休業' : isRegClosed ? '定休日（水曜）' : '臨時休業日';
    } else {
      el.classList.add('available');
      if (isSelected) el.classList.add('selected');
      el.addEventListener('click', () => selectDate(dateStr));
    }

    grid.appendChild(el);
  }
}

function formatDate(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function selectDate(dateStr) {
  state.selectedDate = dateStr;
  state.selectedTime = null;
  renderCalendar();

  const [y, m, d] = dateStr.split('-');
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  document.getElementById('selectedDateDisplay').textContent =
    `${y}年${parseInt(m)}月${parseInt(d)}日（${WD[dow]}）`;

  loadTimeSlots(dateStr);
  goStep(3);
}

/* ===== Step3: 時間スロット ===== */
async function loadTimeSlots(dateStr) {
  const grid = document.getElementById('timeGrid');
  grid.innerHTML = '<div class="time-loading">読み込み中…</div>';

  try {
    const res = await fetch(`/api/availability?date=${dateStr}&serviceId=${state.serviceId}`);
    const data = await res.json();

    grid.innerHTML = '';
    if (data.closed) {
      grid.innerHTML = '<p class="no-slots">この日は定休日・休業日です</p>';
      return;
    }
    if (!data.slots || data.slots.length === 0) {
      grid.innerHTML = '<p class="no-slots">この日は空き枠がありません</p>';
      return;
    }

    data.slots.forEach(slot => {
      const btn = document.createElement('button');
      const isSelected = slot.time === state.selectedTime;

      let slotClass = 'available';
      if (slot.blocked)         slotClass = 'blocked';
      else if (!slot.available) slotClass = 'booked';
      btn.className = 'time-slot ' + slotClass;
      if (isSelected) btn.classList.add('selected');

      const timeEl = document.createElement('span');
      timeEl.className = 'slot-time';
      timeEl.textContent = slot.time;

      const labelEl = document.createElement('span');
      labelEl.className = 'slot-label';
      if (isSelected)       labelEl.textContent = '選択中';
      else if (slot.blocked)    { labelEl.textContent = '─ 停止中'; btn.disabled = true; }
      else if (!slot.available) { labelEl.textContent = '× 予約済み'; btn.disabled = true; }
      else                  labelEl.textContent = '○ 空き';

      btn.appendChild(timeEl);
      btn.appendChild(labelEl);

      if (slot.available && !slot.blocked && !isSelected) {
        btn.addEventListener('click', () => selectTime(slot.time, slot.endTime));
      }
      grid.appendChild(btn);
    });
  } catch {
    grid.innerHTML = '<p class="no-slots">読み込みに失敗しました。再度お試しください。</p>';
  }
}

function selectTime(time, endTime) {
  state.selectedTime = time;
  document.querySelectorAll('.time-slot').forEach(btn => {
    const slotTime = btn.querySelector('.slot-time')?.textContent;
    const label    = btn.querySelector('.slot-label');
    const isThis   = slotTime === time;
    btn.classList.toggle('selected', isThis);
    if (label && btn.classList.contains('available')) {
      label.textContent = isThis ? '選択中' : '○ 空き';
    }
  });

  const svc = SERVICES_INFO[state.serviceId];
  const [y, m, d] = state.selectedDate.split('-');
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const dow = new Date(state.selectedDate + 'T00:00:00').getDay();
  const calcEnd = endTime || minsToTime(timeToMins(time) + (svc ? svc.duration : 60));

  document.getElementById('bookingSummary').innerHTML = `
    <strong>ご予約内容</strong><br>
    日付：${y}年${parseInt(m)}月${parseInt(d)}日（${WD[dow]}）<br>
    時間：${time} 〜 ${calcEnd}<br>
    サービス：${svc ? svc.name : state.serviceId}<br>
    料金：¥${svc ? svc.price.toLocaleString() : '—'}〜（税込）
  `;

  setTimeout(() => goStep(4), 200);
}

/* ===== Step4: フォーム送信 ===== */
document.getElementById('bookingForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = '送信中…';

  const body = {
    date:          state.selectedDate,
    startTime:     state.selectedTime,
    serviceId:     state.serviceId,
    name:          document.getElementById('fname').value.trim(),
    phone:         document.getElementById('fphone').value.trim(),
    email:         document.getElementById('femail').value.trim(),
    address:       document.getElementById('faddress').value.trim(),
    notes:         document.getElementById('fnotes').value.trim(),
    paymentMethod: document.querySelector('input[name="payment"]:checked')?.value || 'cash',
  };

  try {
    const res = await fetch('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok) {
      alert(data.error || '予約に失敗しました。再度お試しください。');
      btn.disabled = false;
      btn.textContent = '予約を確定する';
      return;
    }

    const bk = data.booking;
    const WD = ['日', '月', '火', '水', '木', '金', '土'];
    const dow = new Date(bk.date + 'T00:00:00').getDay();
    const [y, m, d] = bk.date.split('-');

    const doneMsg = document.getElementById('doneMsg');
    const doneTel = document.getElementById('doneTel');
    const payLabel = bk.paymentMethod === 'paypay' ? 'PayPay' : bk.paymentMethod === 'credit' ? 'クレジットカード' : '現金';
    if (bk.email) {
      doneMsg.innerHTML = 'ご予約ありがとうございます。<br>確認メールをご確認ください。';
      if (doneTel) doneTel.style.display = 'none';
    } else {
      doneMsg.innerHTML = 'ご予約ありがとうございます。<br>ご不明な点はお問い合わせください。';
      if (doneTel) doneTel.style.display = '';
    }

    document.getElementById('doneDetail').innerHTML = `
      日付：${y}年${parseInt(m)}月${parseInt(d)}日（${WD[dow]}）<br>
      時間：${bk.startTime} 〜 ${bk.endTime}<br>
      サービス：${bk.serviceName}<br>
      料金：¥${bk.price.toLocaleString()}〜（税込）<br>
      お名前：${bk.name} 様<br>
      住所：${bk.address || '—'}<br>
      お支払い：${payLabel}
    `;

    for (let i = 1; i <= 4; i++) {
      const el = document.getElementById('step-' + i);
      if (el) el.classList.add('hidden');
    }
    document.getElementById('step-done').classList.remove('hidden');
    for (let i = 1; i <= 4; i++) {
      const si = document.getElementById('si-' + i);
      if (si) { si.classList.remove('active'); si.classList.add('done'); }
    }
  } catch {
    alert('通信エラーが発生しました。再度お試しください。');
    btn.disabled = false;
    btn.textContent = '予約を確定する';
  }
});

/* ===== リセット ===== */
function resetBooking() {
  state.serviceId   = null;
  state.selectedDate = null;
  state.selectedTime = null;
  document.getElementById('bookingForm').reset();
  document.querySelectorAll('.bsvc-btn').forEach(b => b.classList.remove('selected'));
  goStep(1);
  scrollToBooking();
}

/* ===== ユーティリティ ===== */
function timeToMins(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function minsToTime(m) { return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`; }

/* ===== 初期化 ===== */
renderCalendar();
goStep(1);
