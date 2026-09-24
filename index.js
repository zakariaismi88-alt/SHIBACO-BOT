const {
  default: makeWASocket, fetchLatestWaWebVersion,
  useMultiFileAuthState,
  DisconnectReason,
  downloadContentFromMessage,
  areJidsSameUser
} = require('@whiskeysockets/baileys');
const P = require('pino');

const _oldConsoleError=console.error;
const _oldConsoleLog=console.log;

function _isBadMac(...args){
  return args.some(x=>/Bad MAC|Failed to decrypt message with any known session|Session error:Error: Bad MAC/i.test(String(x)));
}

console.error=(...args)=>{
  if(_isBadMac(...args)) return;
  _oldConsoleError(...args);
};

console.log=(...args)=>{
  if(_isBadMac(...args)) return;
  _oldConsoleLog(...args);
};

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const FFMPEG_STATIC = (() => { try { return require('ffmpeg-static'); } catch { return null; } })();
const YTDlpWrap = (() => { try { return require('yt-dlp-wrap-plus').default; } catch { return null; } })();
let LOCAL_YTDLP = null;

const CONFIG = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const PREFIX = CONFIG.prefix || '.';

// SHIBACO — كشف الكلمات المسيئة والتحايل عليها
const SHIBACO_BAD_WORDS=[
  'غبي','احمق','أحمق','حمار','كلب','قذر','تافه','سخيف','حقير','نذل',
  'وسخ','كذاب','كاذب','ملعون','لعين'
];

function shibacoNormalizeText(text){
  return String(text||'')
    .normalize('NFKC')
    .replace(/[\\u064B-\\u065F\\u0670]/g,'')
    .replace(/[ـ]/g,'')
    .replace(/[أإآٱ]/g,'ا')
    .replace(/[ة]/g,'ه')
    .replace(/[ى]/g,'ي')
    .replace(/[ئ]/g,'ي')
    .replace(/[ؤ]/g,'و')
    .replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))
    .replace(/[０-９]/g,c=>String('０１２３４５６７８９'.indexOf(c)))
    .replace(/[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]/g,'')
    .toLowerCase();
}

function shibacoCompact(text){
  return shibacoNormalizeText(text)
    .replace(/[^\\p{L}\\p{N}]/gu,'');
}

function shibacoSqueeze(text){
  return shibacoCompact(text)
    .replace(/(.)\\1+/gu,'$1');
}

function shibacoBadWordDetected(text){
  const original=shibacoNormalizeText(text);
  const compact=shibacoCompact(text);
  const squeezed=shibacoSqueeze(text);

  const words=Array.isArray(SHIBACO_BAD_WORDS)
    ? SHIBACO_BAD_WORDS
    : [];

  return words.some(word=>{
    const w=shibacoCompact(word);
    if(!w || w.length<3)return false;

    // كلمة عادية
    if(original.split(/\\s+/).some(x=>shibacoCompact(x)===w))return true;

    // مسافات/رموز/فواصل بين الحروف
    if(compact.includes(w))return true;

    // تكرار الحروف: كككلمة / ممم...
    if(squeezed.includes(w))return true;

    // حالات كتابة متقطعة
    const spaced=w.split('').join('[^\\p{L}\\p{N}]*');
    try{
      if(new RegExp(spaced,'iu').test(original))return true;
    }catch{}

    return false;
  });
}

const DB_FILE = './database.json';
const AUTH_DIR = './auth';
const MENU_IMAGE = path.join(__dirname, 'media', 'bot.jpg');
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : { users: {}, groups: {} };
db.users ||= {};
db.groups ||= {};

function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.log('DB SAVE ERROR:', e.message); }
}
function user(id) {
  if (!db.users[id]) {
    db.users[id] = {
      xp: 0, level: 1, messages: 0, money: 1000, bank: 0, gems: 0,
      wins: 0, losses: 0, warnings: 0, daily: 0, work: 0, lastXP: 0,
      anime: 'ليفاي', aiCharacter: 'مساعد SHIBACO'
    };
  }
  const u = db.users[id];
  u.xp ??= 0; u.level ??= 1; u.messages ??= 0; u.money ??= 1000; u.bank ??= 0; u.gems ??= 0;
  u.wins ??= 0; u.losses ??= 0; u.warnings ??= 0; u.daily ??= 0; u.work ??= 0; u.lastXP ??= 0;
  u.anime ??= 'ليفاي'; u.aiCharacter ??= 'مساعد SHIBACO';
  return u;
}
function group(id) {
  if (!db.groups[id]) db.groups[id] = {};
  const g = db.groups[id];
  g.interaction ||= {};
  g.protection ||= {};
  Object.assign(g.protection, {
    enabled: g.protection.enabled ?? true,
    links: g.protection.links ?? false,
    spam: g.protection.spam ?? false,
    repeat: g.protection.repeat ?? false,
    mentions: g.protection.mentions ?? false
  });
  g._spam ||= {}; g._repeat ||= {};
  return g;
}
function nameOf(id) { return String(id || '').split('@')[0].split(':')[0]; }
function money(n) { return Number(n || 0).toLocaleString('en-US'); }
function level(u) { return Math.floor(Number(u.xp || 0) / 500) + 1; }
function xpNext(u) { return level(u) * 500; }
function textOf(m) {
  return (m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || m.message?.videoMessage?.caption || '').trim();
}
function mentioned(m) {
  const c = m.message?.extendedTextMessage?.contextInfo;
  return c?.mentionedJid?.[0] || c?.participant || null;
}
function quotedMessage(m) { return m.message?.extendedTextMessage?.contextInfo?.quotedMessage || null; }
function box(title, body) { return `╭━━━〔 ${title} 〕━━━╮\n${body}\n╰━━━━━━━━━━━━━━━━━━╯`; }
const GAME_MESSAGES=new Map();

function gameReply(sock,jid,text,quoted,mentions){
  return sock.sendMessage(
    jid,
    {text,...(mentions?{mentions}:{})},
    {quoted}
  ).then(msg=>{
    if(msg?.key?.id) GAME_MESSAGES.set(jid,msg.key.id);
    return msg;
  });
}

function reply(sock, jid, text, quoted, mentions) { return gameReply(sock,jid,text,quoted,mentions); }
function isGroup(jid) { return String(jid).endsWith('@g.us'); }
function normalizeJid(id) {
  if (!id) return '';
  return String(id).replace(/:\d+(?=@)/, '');
}
function sameJid(a, b) {
  if (!a || !b) return false;
  try { if (areJidsSameUser(a, b)) return true; } catch {}
  return normalizeJid(a) === normalizeJid(b);
}
function cleanJid(v){
  return String(v||'')
    .toLowerCase()
    .replace(/:\d+(?=@)/g,'')
    .replace(/[^0-9a-z@._-]/g,'');
}

function jidVariants(v){
  if(!v)return [];
  const x=cleanJid(v);
  const out=[x];

  if(x.includes('@')){
    out.push(x.split('@')[0]);
  }

  return [...new Set(out.filter(Boolean))];
}

function sameJid(a,b){
  if(!a||!b)return false;

  try{
    if(areJidsSameUser(a,b))return true;
  }catch{}

  const A=jidVariants(a);
  const B=jidVariants(b);

  return A.some(x=>B.includes(x));
}

function isAdmin(meta,id){
  if(!meta?.participants||!id)return false;

  return meta.participants.some(p=>{
    if(
      p?.admin!=='admin' &&
      p?.admin!=='superadmin' &&
      p?.admin!==true
    )return false;

    return [
      p?.id,
      p?.jid,
      p?.lid,
      p?.phoneNumber,
      p?.phone
    ].filter(Boolean).some(x=>sameJid(x,id));
  });
}

function isBotAdmin(meta,sock){
  if(!meta?.participants||!sock)return false;

  const ids=[
    sock?.user?.id,
    sock?.user?.lid,
    sock?.user?.jid,
    sock?.user?.phoneNumber,
    sock?.user?.verifiedName
  ].filter(Boolean);

  return meta.participants.some(p=>{
    const admin=
      p?.admin==='admin' ||
      p?.admin==='superadmin' ||
      p?.admin===true;

    if(!admin)return false;

    const participantIds=[
      p?.id,
      p?.jid,
      p?.lid,
      p?.phoneNumber,
      p?.phone
    ].filter(Boolean);

    return participantIds.some(pid=>
      ids.some(botid=>sameJid(pid,botid))
    );
  });
}


function getSenderIds(m,jid,sender){
  const out=[
    sender,
    m?.key?.participant,
    m?.key?.participantAlt,
    m?.key?.remoteJid,
    m?.key?.remoteJidAlt,
    jid
  ];

  return [...new Set(
    out
      .filter(Boolean)
      .map(x=>String(x))
  )];
}

function isOwner(id, alt, m, jid, meta){
  const owners=['212788826407','212689100503'];

  const vals=[
    id,alt,jid,
    m?.key?.participant,
    m?.key?.participantAlt,
    m?.key?.participantPn,
    m?.key?.remoteJid,
    m?.key?.remoteJidAlt,
    m?.message?.extendedTextMessage?.contextInfo?.participant,
    m?.message?.extendedTextMessage?.contextInfo?.participantAlt,
    CONFIG?.owner,
    CONFIG?.owners,
    ...(meta?.participants||[]).flatMap(x=>[
      x?.id,x?.jid,x?.lid,x?.phoneNumber,x?.phone
    ])
  ];

  const numbers=vals.flatMap(v=>{
    if(v==null)return [];
    return String(v).split(/[\/,\s]+/).map(x=>x.replace(/\D/g,'')).filter(Boolean);
  });

  return numbers.some(n=>
    owners.some(o=>n===o || n.endsWith(o))
  );
}
function canAdmin(meta, id) { return isOwner(id) || isAdmin(meta, id); }
function botIds(sock) {
  return [sock.user?.id, sock.user?.lid, sock.user?.jid, sock.user?.phoneNumber].filter(Boolean);
}
function isBotAdmin(meta,sock){
  if(!meta?.participants)return false;

  const ids=[
    sock?.user?.id,
    sock?.user?.lid,
    sock?.user?.jid,
    sock?.user?.phoneNumber,
    sock?.user?.verifiedName
  ].filter(Boolean);

  const clean=v=>String(v||'').toLowerCase().replace(/[^0-9a-z:@._-]/g,'');

  const botIds=ids.map(clean);

  return meta.participants.some(p=>{
    const vals=[
      p?.id,
      p?.jid,
      p?.lid,
      p?.phoneNumber,
      p?.phone
    ].filter(Boolean).map(clean);

    const admin=p?.admin==='admin' ||
               p?.admin==='superadmin' ||
               p?.admin===true;

    if(!admin)return false;

    return vals.some(v=>
      botIds.includes(v) ||
      botIds.some(b=>v && b && (v.endsWith(b)||b.endsWith(v)))
    );
  });
}
function section(title, commands) {
  return box(title, commands.map((c, i) => `│ ${String(i + 1).padStart(2, '0')} │ ${c}`).join('\n'));
}

const SECTIONS = {
  ق1: { title: '🎌 قسم الأنمي', commands: ['.انمي اسم', '.شخصية اسم', '.بحث_انمي اسم', '.انمي_عشوائي', '.صورة_انمي اسم', '.اقتباس_انمي', '.مانجا اسم', '.بحث_مانجا اسم', '.موسم_الانمي', '.اخبار_انمي'] },
  ق2: { title: '🎮 قسم الألعاب', commands: [
'.اكس_او @عضو','.اربع_على_سطر @عضو','.السفينة_الحربية @عضو',
'.حقل_الالغام','.تفبيك_القنبلة','.الهروب_من_السجن','.سؤال_وخبرة',
'.سرقة_XP @عضو','.شجرة_المهارات','.ترتيب_الخبرة','.عجلة_الحظ',
'.كلمة_السر','.من_هو_اللاعب','.تخمين_الاعلام','.تحدي_السرعة',
'.صيد_الوحوش','.قتال_البارون','.المتاهة','.احزر_الايموجي',
'.حبل_المشنقة','.لو_خيروك','.مظلوم_او_ظالم'
] },
  ق3: { title: '🤖 قسم الذكاء الاصطناعي', commands: ['.ai سؤال', '.اسأل سؤال', '.شخصية_ai اسم', '.محادثة سؤال', '.ترجم نص', '.لخص نص', '.اكتب نص', '.صحح نص', '.برمج سؤال', '.مسح_محادثة'] },
  ق4: { title: '👤 قسم الشخصيات', commands: ['.شخصيتي', '.بطاقتي', '.شخصية اسم', '.اختار_شخصية', '.تغيير_شخصية اسم', '.معلومات_شخصية اسم', '.حب_شخصية', '.زواج @عضو', '.طلاق', '.توافق @عضو'] },
  ق5: { title: '⭐ قسم XP والمستويات', commands: ['.لوحتي', '.لفلي', '.مستوى', '.اكسبي', '.ترتيب', '.توب', '.جوائز', '.مكافأة', '.احصائيات', '.تطوير'] },
  ق6: { title: '📊 قسم التفاعل', commands: ['.التفاعل', '.تجديد التفاعل', '.توب_التفاعل', '.رسائلي', '.نشاطي', '.نشاط_القروب', '.احصائيات_القروب', '.اكثر_شخص', '.اقل_شخص', '.ترتيب_التفاعل'] },
  ق7: { title: '💰 قسم الاقتصاد والبنك', commands: ['.رصيد', '.بنك', '.ايداع 500', '.سحب 500', '.تحويل @عضو 500', '.يومي', '.عمل', '.متجر', '.شراء 1', '.ثروتي'] },
  ق8: { title: '🛡️ قسم الحماية', commands: ['.حماية تشغيل', '.مضاد_الروابط تشغيل', '.مضاد_السبام تشغيل', '.مضاد_التكرار تشغيل', '.مضاد_المنشن تشغيل', '.تحذير @عضو', '.تحذيرات @عضو', '.صفر_تحذيرات @عضو', '.قائمة_الحماية', '.اعدادات_الحماية'] },
  ق9: { title: '👑 قسم الإدارة', commands: ['.طرد @عضو', '.حظر @عضو', '.فك_الحظر @عضو', '.ترقية @عضو', '.تنزيل @عضو', '.مسح ← رد', '.قفل', '.فتح', '.منشن', '.تحذير @عضو'] },
  ق10: { title: '⚙️ قسم النظام', commands: ['.بوت', '.سرعة', '.معلومات', '.معلومات_القروب', '.المطور', '.وقت', '.اصدار', '.اعدادات', '.مساعدة', '.اوامر'] },
  ق11: { title: '🎭 قسم الترفيه', commands: ['.نكتة', '.معلومة', '.سؤال', '.صراحة', '.جرأة', '.حب', '.توافق', '.اختار أ،ب،ج', '.احزر', '.فرفشة', '.ميم', '.حكم', '.كلمة_سر', '.من_يشبهني', '.عشوائي'] },
  ق13: { title: '🎯 قسم حسابات الألعاب', commands: ['.فري_فاير UID/اسم', '.ببجي ID/اسم', '.كود ID/اسم', '.فورتنايت ID/اسم', '.فالورانت اسم#TAG', '.ليج اسم', '.روبلوكس اسم', '.روكيت_ليج ID', '.كلاش ID', '.كلاش_رويال ID'] },
  ق14: { title: '🎵 قسم الموسيقى', commands: ['.سبوتيفاي اسم الأغنية', '.اغنية اسم الأغنية', '.فنان اسم الفنان', '.البوم اسم الألبوم'] },
  ق12: { title: '📥 قسم التحميل والبحث', commands: ['.mp4 رابط', '.mp3 رابط', '.تيك بحث', '.ايديت اسم', '.صورة اسم 3', '.ستيكر ← رد على صورة', '.ملصق اسم', '.فيديو رابط', '.صوت رابط', '.تحميل رابط', '.يوتيوب رابط', '.فيسبوك رابط', '.تيكتوك رابط'] }
};
function mainMenu() {
  return box('📚 SHIBACO BOT', `│ 01 ┃ 🎌 قسم الأنمي → .ق1\n│ 02 ┃ 🎮 قسم الألعاب → .ق2\n│ 03 ┃ 🤖 قسم الذكاء الاصطناعي → .ق3\n│ 04 ┃ 👤 قسم الشخصيات → .ق4\n│ 05 ┃ ⭐ قسم XP والمستويات → .ق5\n│ 06 ┃ 📊 قسم التفاعل → .ق6\n│ 07 ┃ 💰 قسم الاقتصاد والبنك → .ق7\n│ 08 ┃ 🛡️ قسم الحماية → .ق8\n│ 09 ┃ 👑 قسم الإدارة → .ق9\n│ 10 ┃ ⚙️ قسم النظام → .ق10\n│ 11 ┃ 🎭 قسم الترفيه → .ق11\n│ 12 ┃ 📥 قسم التحميل والبحث → .ق12\n│ 13 ┃ 🎯 حسابات الألعاب → .ق13\n│ 14 ┃ 🎵 الموسيقى → .ق14\n│\n│ ⚡ اكتب رقم القسم مثل .ق1 أو .ق14`);
}
function help(q) {
  const key = q.trim().toLowerCase();
  if (SECTIONS[key]) return section(SECTIONS[key].title, SECTIONS[key].commands);
  if (key === 'الكل') return mainMenu();
  return box('📚 SHIBACO HELP', '│ .اوامر → لوحة الأوامر بالصورة\n│ .ق1 → الأنمي\n│ .ق2 → الألعاب\n│ .ق3 → AI\n│ .ق4 → الشخصيات\n│ .ق5 → XP\n│ .ق6 → التفاعل\n│ .ق7 → الاقتصاد\n│ .ق8 → الحماية\n│ .ق9 → الإدارة\n│ .ق10 → النظام\n│ .ق11 → الترفيه\n│ .ق12 → التحميل والبحث\n│ .ق13 → حسابات الألعاب\n│ .ق14 → الموسيقى');
}

async function fetchJSON(url, options = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, options);
      const j = await r.json().catch(() => null);
      if (r.ok) return j;
      last = new Error(`HTTP ${r.status}`);
      if (![429, 500, 502, 503, 504].includes(r.status)) throw last;
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 700 * (i + 1)));
  }
  throw last || new Error('request failed');
}

const SHIBACO_AR={
  'naruto':'ناروتو','naruto shippuden':'ناروتو شيبودن',
  'one piece':'ون بيس','bleach':'بليتش',
  'dragon ball':'دراغون بول','dragon ball z':'دراغون بول زد',
  'dragon ball super':'دراغون بول سوبر',
  'attack on titan':'هجوم العمالقة','shingeki no kyojin':'هجوم العمالقة',
  'demon slayer':'قاتل الشياطين','kimetsu no yaiba':'قاتل الشياطين',
  'jujutsu kaisen':'جوجوتسو كايسن',
  'my hero academia':'أكاديمية بطلي','boku no hero academia':'أكاديمية بطلي',
  'hunter x hunter':'هنتر x هنتر',
  'death note':'مذكرة الموت',
  'tokyo ghoul':'طوكيو غول',
  'solo leveling':'سولو ليفلينج',
  'blue lock':'بلو لوك',
  'black clover':'بلاك كلوفر',
  'fairy tail':'فيري تيل',
  'sword art online':'سورد آرت أونلاين',
  'fullmetal alchemist':'الخيميائي الفولاذي',
  'haikyuu':'هايكيو',
  'spy x family':'سباي x فاميلي',
  'chainsaw man':'رجل المنشار',
  'one punch man':'ون بنش مان',
  'mob psycho 100':'موب سايكو 100',
  'vinland saga':'ملحمة فينلاند',
  'blue box':'الصندوق الأزرق',
  'frieren':'فرييرن',
  'levi':'ليفاي','levi ackerman':'ليفاي أكرمان',
  'goku':'غوكو','vegeta':'فيجيتا','naruto uzumaki':'ناروتو أوزوماكي',
  'sasuke':'ساسكي','sakura':'ساكورا','itachi':'إيتاتشي',
  'luffy':'لوفي','roronoa zoro':'رورونوا زورو','zoro':'زورو',
  'sanji':'سانجي','nami':'نامي','ichigo':'إيتشيغو',
  'rukia':'روكيا','gojo':'غوجو','satoru gojo':'ساتورو غوجو',
  'yuji itadori':'يوجي إيتادوري','megumi fushiguro':'ميغومي فوشيغورو',
  'tanjiro':'تانجيرو','nezuko':'نيزوكو','inosuke':'إينوسكي',
  'eren':'إيرين','eren yeager':'إيرين ييغر','mikasa':'ميكاسا',
  'light yagami':'لايت ياغامي','killua':'كيلوا','gon':'غون',
  'hisoka':'هيسوكا','aizen':'آيزن'
};

function shibacoArabic(v){
  const x=String(v||'').trim();
  if(!x)return '';
  return SHIBACO_AR[x.toLowerCase()]||x;
}

function shibacoArabicDescription(v){
  return String(v||'لا توجد نبذة.')
    .replace(/<[^>]*>/g,'')
    .replace(/\n+/g,' ')
    .replace(/\\s+/g,' ')
    .trim()
    .slice(0,900);
}
async function animeSearch(sock,jid,query,m){
  if(!query)return reply(sock,jid,'🎌 استخدم: .انمي ناروتو',m);
  try{
    const r=await fetch('https://graphql.anilist.co',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        query:'query($s:String!){Page(perPage:10){media(search:$s,type:ANIME,sort:SEARCH_MATCH){title{romaji english native}episodes averageScore status genres description coverImage{large}}}}',
        variables:{s:String(query)}
      })
    });
    const j=await r.json();
    const list=j?.data?.Page?.media||[];
    if(!list.length)return reply(sock,jid,'❌ لم أجد الأنمي.',m);
    const a=list[0];
    const original=a.title?.romaji||a.title?.english||query;
    const title=shibacoArabic(query)!==query?shibacoArabic(query):shibacoArabic(original);
    const desc=shibacoArabicDescription(a.description);

    const caption=box('🎌 SHIBACO ANIME',
      '│ 🏷️ الاسم: '+title+
      '\n│ ⭐ التقييم: '+(a.averageScore?(a.averageScore/10).toFixed(1):'؟')+
      '\n│ 📺 الحلقات: '+(a.episodes??'؟')+
      '\n│ 📅 الحالة: '+(a.status??'؟')+
      '\n│ 🎭 '+((a.genres||[]).join(' • ')||'؟')+
      '\n│\n│ 📝 '+desc);

    if(a.coverImage?.large)
      return sock.sendMessage(jid,{image:{url:a.coverImage.large},caption},{quoted:m});
    return reply(sock,jid,caption,m);
  }catch(e){
    console.log('ANIME ERROR:',e.message);
    return reply(sock,jid,'❌ تعذر جلب الأنمي الآن.',m);
  }
}
async function characterSearch(sock,jid,query,m){
  if(!query)return reply(sock,jid,'👤 استخدم: .شخصية ليفاي',m);
  try{
    const aliases={
      'ليفاي':'Levi','ليفاي أكرمان':'Levi Ackerman',
      'غوكو':'Goku','فيجيتا':'Vegeta','ناروتو':'Naruto Uzumaki',
      'ساسكي':'Sasuke Uchiha','لوفي':'Monkey D. Luffy',
      'زورو':'Roronoa Zoro','سانجي':'Sanji',
      'إيتاتشي':'Itachi Uchiha','غوجو':'Satoru Gojo',
      'تانجيرو':'Tanjiro Kamado','نيزوكو':'Nezuko Kamado',
      'إيرين':'Eren Yeager','ميكاسا':'Mikasa Ackerman',
      'كيلوا':'Killua Zoldyck','غون':'Gon Freecss'
    };
    const search=aliases[String(query).trim()]||query;

    const r=await fetch('https://graphql.anilist.co',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        query:'query($s:String!){Page(perPage:10){characters(search:$s){name{full native alternative}description image{large}}}}',
        variables:{s:String(search)}
      })
    });
    const j=await r.json();
    const list=j?.data?.Page?.characters||[];
    if(!list.length)return reply(sock,jid,'❌ لم أجد الشخصية. جرّب الاسم بالإنجليزي.',m);

    const a=list[0];
    const title=shibacoArabic(query)!==query?shibacoArabic(query):shibacoArabic(a.name?.full);
    const desc=shibacoArabicDescription(a.description);

    const caption=box('👤 SHIBACO CHARACTER',
      '│ 👤 الاسم: '+title+
      '\n│ 🔤 الاسم الأصلي: '+(a.name?.full||'؟')+
      '\n│\n│ 📝 '+desc);

    if(a.image?.large)
      return sock.sendMessage(jid,{image:{url:a.image.large},caption},{quoted:m});
    return reply(sock,jid,caption,m);
  }catch(e){
    console.log('CHARACTER ERROR:',e.message);
    return reply(sock,jid,'❌ تعذر جلب الشخصية الآن.',m);
  }
}
async function mangaSearch(sock,jid,query,m){
  if(!query)return reply(sock,jid,'📚 استخدم: .مانجا ون بيس',m);
  try{
    const aliases={
      'ون بيس':'One Piece','ناروتو':'Naruto','بليتش':'Bleach',
      'هجوم العمالقة':'Shingeki no Kyojin','قاتل الشياطين':'Kimetsu no Yaiba',
      'جوجوتسو كايسن':'Jujutsu Kaisen','بلو لوك':'Blue Lock',
      'بلاك كلوفر':'Black Clover','سولو ليفلينج':'Solo Leveling',
      'رجل المنشار':'Chainsaw Man','ون بنش مان':'One Punch-Man'
    };
    const search=aliases[String(query).trim()]||query;

    const r=await fetch('https://graphql.anilist.co',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        query:'query($s:String!){Page(perPage:10){media(search:$s,type:MANGA,sort:SEARCH_MATCH){title{romaji english native}chapters volumes averageScore status description coverImage{large}}}}',
        variables:{s:String(search)}
      })
    });
    const j=await r.json();
    const list=j?.data?.Page?.media||[];
    if(!list.length)return reply(sock,jid,'❌ لم أجد المانجا.',m);

    const a=list[0];
    const title=shibacoArabic(query)!==query?shibacoArabic(query):shibacoArabic(a.title?.romaji);
    const desc=shibacoArabicDescription(a.description);

    const caption=box('📚 SHIBACO MANGA',
      '│ 🏷️ الاسم: '+title+
      '\n│ ⭐ التقييم: '+(a.averageScore?(a.averageScore/10).toFixed(1):'؟')+
      '\n│ 📚 الفصول: '+(a.chapters??'؟')+
      '\n│ 📖 المجلدات: '+(a.volumes??'؟')+
      '\n│ 📅 الحالة: '+(a.status??'؟')+
      '\n│\n│ 📝 '+desc);

    if(a.coverImage?.large)
      return sock.sendMessage(jid,{image:{url:a.coverImage.large},caption},{quoted:m});
    return reply(sock,jid,caption,m);
  }catch(e){
    console.log('MANGA ERROR:',e.message);
    return reply(sock,jid,'❌ تعذر جلب المانجا الآن.',m);
  }
}
async function currentAnimeSeason(sock,jid,m){
  try{
    const now=new Date();
    const month=now.getUTCMonth();
    const season=month<3?'WINTER':month<6?'SPRING':month<9?'SUMMER':'FALL';
    const year=now.getUTCFullYear();

    const r=await fetch('https://graphql.anilist.co',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        query:'query($season:MediaSeason!,$year:Int!){Page(perPage:10){media(season:$season,seasonYear:$year,type:ANIME,sort:POPULARITY_DESC){title{romaji}episodes averageScore}}}',
        variables:{season,year}
      })
    });

    const j=await r.json();
    const list=j?.data?.Page?.media||[];
    if(!list.length)return reply(sock,jid,'❌ لا توجد بيانات للموسم الآن.',m);

    return reply(sock,jid,
      box('📅 SHIBACO — موسم '+season,
        list.map((a,i)=>
          '│ '+(i+1)+'️⃣ '+a.title.romaji+
          '\n│ ⭐ '+(a.averageScore?(a.averageScore/10).toFixed(1):'؟')+
          ' • 📺 '+(a.episodes??'؟')+' حلقة'
        ).join('\n\n')),m);
  }catch(e){
    console.log('ANILIST SEASON:',e.message);
    return reply(sock,jid,'❌ تعذر جلب الموسم الحالي الآن.',m);
  }
}
async function animeNews(sock,jid,m){
  try{
    const r=await fetch('https://graphql.anilist.co',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        query:'query{Page(perPage:10){media(type:ANIME,sort:UPDATED_AT_DESC){title{romaji}episodes averageScore status}}}'
      })
    });

    const j=await r.json();
    const list=j?.data?.Page?.media||[];
    if(!list.length)return reply(sock,jid,'❌ لا توجد بيانات أنمي الآن.',m);

    return reply(sock,jid,
      box('📰 SHIBACO ANIME',
        list.map((a,i)=>
          '│ '+(i+1)+'️⃣ '+a.title.romaji+
          '\n│ ⭐ '+(a.averageScore?(a.averageScore/10).toFixed(1):'؟')+
          ' • 📺 '+(a.episodes??'؟')+' حلقة'
        ).join('\n\n')),m);
  }catch(e){
    console.log('ANILIST NEWS:',e.message);
    return reply(sock,jid,'❌ تعذر جلب بيانات الأنمي الآن.',m);
  }
}

async function askAI(prompt, character, mode = 'chat') {
  if (!CONFIG.geminiKey) throw new Error('AI غير مفعّل: ضع geminiKey في config.json');

  const model = 'gemini-3.5-flash-lite';
  const systems = {
    translate: 'ترجم النص المطلوب بدقة. لا تضف شرحاً.',
    summarize: 'لخص النص باختصار.',
    write: 'اكتب النص المطلوب بشكل مرتب وقصير.',
    correct: 'صحح النص مع الحفاظ على المعنى.',
    code: 'ساعد في البرمجة باختصار.',
    chat: 'أجب بالعربية باختصار ووضوح.'
  };

  const system = `أنت ${character || 'مساعد SHIBACO'}. ${systems[mode] || systems.chat}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': String(CONFIG.geminiKey).trim()
    },
    body: JSON.stringify({
      systemInstruction: {parts:[{text:system}]},
      contents: [{
        role:'user',
        parts:[{text:String(prompt || 'مرحبا').slice(0,2000)}]
      }],
      generationConfig: {
        maxOutputTokens: 120,
        thinkingConfig: {thinkingLevel:'minimal'}
      }
    })
  });

  const j = await r.json().catch(()=>({}));

  if (!r.ok) {
    throw new Error(`Gemini HTTP ${r.status}: ${j?.error?.message || 'خطأ'}`);
  }

  return j?.candidates?.[0]?.content?.parts
    ?.map(x=>x.text||'')
    .join('')
    .trim() || 'لم يصل رد.';
}

async function resolveYtDlp() {
  const local = [path.join(__dirname,'yt-dlp'), path.join(__dirname,'bin','yt-dlp'), 'yt-dlp', path.join(process.env.HOME||'','.local','bin','yt-dlp'), path.join(process.env.PREFIX||'','bin','yt-dlp')];
  for (const c of local) { try { await execFileAsync(c,['--version'],{timeout:10000}); return {cmd:c,prefix:[]}; } catch {} }
  try { await execFileAsync('python',['-m','yt_dlp','--version'],{timeout:10000}); return {cmd:'python',prefix:['-m','yt_dlp']}; } catch {}
  if (YTDlpWrap) {
    try {
      const bin = path.join(__dirname,'bin','yt-dlp');
      fs.mkdirSync(path.dirname(bin),{recursive:true});
      if (!fs.existsSync(bin)) {
        console.log('⬇️ جاري تجهيز yt-dlp تلقائياً لأول تحميل...');
        await YTDlpWrap.downloadFromGithub(bin,'','linux',true);
        try { fs.chmodSync(bin,0o755); } catch {}
      }
      await execFileAsync(bin,['--version'],{timeout:15000});
      LOCAL_YTDLP = bin;
      return {cmd:bin,prefix:[]};
    } catch (e) { console.log('YTDLP AUTO ERROR:',e.message); }
  }
  throw new Error('yt-dlp غير مثبت على الاستضافة.');
}
function ffmpegPath() {
  return FFMPEG_STATIC || 'ffmpeg';
}
async function runYtDlp(args, timeout=300000) {
  const bin=await resolveYtDlp();
  return execFileAsync(bin.cmd,[...bin.prefix,...args],{maxBuffer:32*1024*1024,timeout});
}
async function shibacoDownload(url,type){
  if(!url)throw new Error('أرسل رابطاً صحيحاً.');
  fs.mkdirSync(DOWNLOAD_DIR,{recursive:true});

  const stamp='sh_'+Date.now();
  const out=path.join(DOWNLOAD_DIR,stamp+'.%(ext)s');
  const ff=ffmpegPath()||'/data/data/com.termux/files/usr/bin';

  const common=[
    '--no-playlist',
    '--no-warnings',
    '--ignore-errors',
    '--retries','5',
    '--fragment-retries','5',
    '--socket-timeout','30',
    '--ffmpeg-location',ff
  ];

  let args=[...common];

  if(type==='mp3'){
    args.push(
      '-x',
      '--audio-format','mp3',
      '--audio-quality','128K',
      '-o',out,
      url
    );
  }else{
    args.push(
      '-f','best[ext=mp4]/best',
      '--merge-output-format','mp4',
      '-o',out,
      url
    );
  }

  await runYtDlp(args,type==='mp3'?300000:420000);

  const files=fs.readdirSync(DOWNLOAD_DIR)
    .filter(x=>x.startsWith(stamp+'.'))
    .map(x=>path.join(DOWNLOAD_DIR,x));

  if(!files.length)throw new Error('yt-dlp لم ينشئ ملفاً.');

  let file;
  if(type==='mp3'){
    file=files.find(x=>x.toLowerCase().endsWith('.mp3'));
  }else{
    file=files.find(x=>x.toLowerCase().endsWith('.mp4'));
  }

  if(!file)file=files[0];
  return file;
}
function mediaUrl(x){return /^https?:\/\/\S+$/i.test(x||'');}
async function tikwmSearch(query,limit=5){
  if(!query)return [];

  const key=CONFIG.socialCrawlKey;
  if(!key)throw new Error("SocialCrawl API Key غير موجود في config.json");

  const url=`https://www.socialcrawl.dev/v1/tiktok/search?query=${encodeURIComponent(query)}&sort_by=relevance`;

  const r=await fetch(url,{
    headers:{
      "x-api-key":key,
      "accept":"application/json"
    }
  });

  const j=await r.json();

  if(!r.ok || !j.success){
    throw new Error(j?.error?.message||`SocialCrawl HTTP ${r.status}`);
  }

  const rows=Array.isArray(j.data)
    ? j.data
    : Array.isArray(j.data?.items)
      ? j.data.items
      : [];

  return rows.slice(0,limit).map(x=>{
    const videoUrl=
      x?.post?.url ||
      x?.post?.webpage_url ||
      x?.post?.share_url ||
      x?.url ||
      x?.webpage_url ||
      x?.share_url ||
      "";

    return {
      title:x?.post?.caption || x?.caption || "TikTok",
      author:x?.post?.author?.username || x?.author?.username || "",
      videoUrl
    };
  }).filter(x=>x.videoUrl);
}
async function sendSearchVideos(sock,jid,m,results,label){
  if(!results.length)return reply(sock,jid,'❌ لم أجد فيديوهات لهذا البحث.',m);

  let sent=0;

  for(const r of results.slice(0,5)){
    try{
      const file=await shibacoDownload(r.videoUrl,'mp4');
      const b=fs.readFileSync(file);

      await sock.sendMessage(jid,{
        video:b,
        mimetype:'video/mp4',
        fileName:'SHIBACO.mp4',
        caption:'🎬 '+label
      },{quoted:sent===0?m:undefined});

      sent++;

      try{fs.unlinkSync(file)}catch(e){}
    }catch(e){
      console.log('VIDEO DOWNLOAD:',e.message);
    }
  }

  if(!sent)return reply(sock,jid,'❌ تعذر تحميل الفيديوهات من المصدر الآن.',m);
}
async function imageSearch(query,limit=10){
  const urls=[];

  const engines=[
    `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}&hl=en`,
    `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2`
  ];

  for(const url of engines){
    try{
      const r=await fetch(url,{
        headers:{
          'User-Agent':'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/122.0 Mobile Safari/537.36',
          'Accept-Language':'en-US,en;q=0.9,ar;q=0.8'
        }
      });

      if(!r.ok)continue;

      const html=await r.text();

      const patterns=[
        /"(?:murl|original)"\s*:\s*"([^"]+)"/gi,
        /https?:\/\/[^"'\\\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s<>]*)?/gi
      ];

      for(const re of patterns){
        for(const m of html.matchAll(re)){
          let u=m[1]||m[0];

          try{
            u=JSON.parse('"'+u.replace(/"/g,'\\"')+'"');
          }catch{}

          u=u
            .replace(/\\u0026/g,'&')
            .replace(/\\u003d/g,'=')
            .replace(/\\\//g,'/')
            .replace(/&amp;/g,'&');

          if(/^https?:\/\//i.test(u) && !urls.includes(u)){
            urls.push(u);
          }

          if(urls.length>=limit*3)break;
        }

        if(urls.length>=limit*3)break;
      }

      if(urls.length>=limit)break;

    }catch(e){
      console.log('IMAGE SEARCH:',e.message||e);
    }
  }

  return urls.slice(0,limit).map((url,i)=>({
    title:`${query} ${i+1}`,
    url,
    mime:'image/*'
  }));
}

async function sendImageResults(sock,jid,m,query,count=3){
  const rs=await imageSearch(query,Math.min(8,Math.max(1,count)));
  if(!rs.length) return reply(sock,jid,'❌ لم أجد صوراً لهذا البحث.',m);
  let sent=0;
  for(const r of rs){try{const b=await fetchBuffer(r.url,12*1024*1024);await sock.sendMessage(jid,{image:b,caption:`🖼️ ${query}\n📌 الصورة ${sent+1}`},{quoted:sent===0?m:undefined});sent++;}catch(e){console.log('IMAGE SEND:',e.message);}}
  if(!sent) return reply(sock,jid,'❌ تعذر إرسال الصور من المصدر الآن.',m);
}
async function downloadImageMessage(msgObj){
  const msg=msgObj.message?.imageMessage;if(!msg)return null;
  const stream=await downloadContentFromMessage(msg,'image');const chunks=[];for await(const c of stream)chunks.push(c);return Buffer.concat(chunks);
}
async function fetchBuffer(url,opts={}){
  if(typeof opts==='number'){
    const r=await fetch(url);
    if(!r.ok)throw new Error('HTTP '+r.status);
    const b=Buffer.from(await r.arrayBuffer());
    if(b.length>opts)throw new Error('FILE_TOO_LARGE');
    return b;
  }
  const r=await fetch(url,opts);
  if(!r.ok)throw new Error('HTTP '+r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function makeSticker(buffer){
  const input=path.join(DOWNLOAD_DIR,`st_in_${Date.now()}.jpg`);const output=path.join(DOWNLOAD_DIR,`st_out_${Date.now()}.webp`);fs.writeFileSync(input,buffer);
  try{await execFileAsync(ffmpegPath(),['-y','-i',input,'-vf','scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0','-vcodec','libwebp','-lossless','0','-q:v','65','-loop','0','-an',output],{timeout:60000});return output;}finally{try{fs.unlinkSync(input)}catch{}}
}
async function sendStickerFromImage(sock,jid,m,b){const f=await makeSticker(b);try{return await sock.sendMessage(jid,{sticker:fs.readFileSync(f)},{quoted:m});}finally{try{fs.unlinkSync(f)}catch{}}}

const JOKES=['😂 ليش الكمبيوتر بردان؟ لأنه فاتح الويندوز.','🤣 مرة مبرمج راح للدكتور، قال له: عندي مشكلة في الذاكرة!','😂 واحد قال للبوت: عندك شخصية؟ قال: حسب الـ config.'];
const FACTS=['🧠 الأخطبوط لديه ثلاثة قلوب.','🌌 على كوكب الزهرة، اليوم أطول من السنة.','🐝 النحل يستطيع تمييز بعض الوجوه.'];
const QUESTIONS=['🎯 لو دخلت عالم أنمي، أي عالم تختار؟','🎯 من أقوى شخصية أنمي برأيك؟','🎯 لو عندك قوة خارقة، ماذا تختار؟'];
const ANIME_NAMES=['One Piece','Naruto','Bleach','Jujutsu Kaisen','Demon Slayer','Attack on Titan'];

function betAmount(u,args,idx=0){const n=Number(args[idx]||0);if(!Number.isInteger(n)||n<10)return null;if(n>u.money)return null;return n;}
function gameResult(u,bet,win){if(win){u.money+=bet;u.wins++;u.xp+=35;return `🏆 فزت!\n💰 +$${money(bet)}\n⭐ +35 XP`;}u.money-=bet*2;u.losses++;return `💀 خسرت!\n💰 -$${money(bet*2)}`;}


async function handle(sock,m,command,args,jid,sender,meta){
  const u=user(sender); if(command==='تجديد'&&args[0]==='التفاعل')command='تجديد_التفاعل';

  const q=args.join(' ').trim();

  if(['ببجي','كود','فورتنايت','فالورانت','ليج','روبلوكس','روكيت_ليج','كلاش','كلاش_رويال'].includes(command)){
    if(!q)
      return reply(sock,jid,`🎮 استخدم: .${command} ID أو اسم اللاعب`,m);

    /* =========================
       🧱 ROBLOX - REAL SEARCH
       ========================= */
    if(command==='روبلوكس'){
      try{
        const r=await fetchJSON(
          'https://users.roblox.com/v1/users/search?keyword='+
          encodeURIComponent(q)+'&limit=10',
          {headers:{'User-Agent':'SHIBACO-BOT/1.0'}},
          3
        );

        const users=r?.data||[];

        if(!users.length)
          return reply(sock,jid,`❌ لم يتم العثور على لاعب Roblox باسم:\n${q}`,m);

        let text='🧱 SHIBACO ROBLOX\n\n';

        users.slice(0,5).forEach((u,i)=>{
          text+=`╭─〔 👤 ${i+1} 〕\n`;
          text+=`│ 👤 الاسم: ${u.name||'غير معروف'}\n`;
          text+=`│ 🏷️ العرض: ${u.displayName||'غير معروف'}\n`;
          text+=`│ 🆔 ID: ${u.id||'غير معروف'}\n`;
          text+=`╰──────────────\n\n`;
        });

        return reply(sock,jid,text+'🌸 SHIBACO BOT',m);

      }catch(e){
        console.log('ROBLOX ERROR:',e.message);
        return reply(sock,jid,'❌ تعذر البحث في Roblox الآن.',m);
      }
    }

    /* =========================
       🎮 باقي الألعاب
       ========================= */

    const games={
      'ببجي':['🪖','PUBG MOBILE','API_KEY_PUBG'],
      'كود':['🔫','CALL OF DUTY','API_KEY_COD'],
      'فورتنايت':['🪂','FORTNITE','API_KEY_FORTNITE'],
      'فالورانت':['🎯','VALORANT','RIOT_API_KEY'],
      'ليج':['⚔️','LEAGUE OF LEGENDS','RIOT_API_KEY'],
      'روكيت_ليج':['🚗','ROCKET LEAGUE','API_KEY_ROCKET'],
      'كلاش':['🏰','CLASH OF CLANS','CLASH_API_KEY'],
      'كلاش_رويال':['👑','CLASH ROYALE','CLASH_API_KEY']
    };

    const g=games[command];

    if(g){
      const cfg=CONFIG||{};

      const keyName=g[2];
      const key=cfg[keyName]||'';

      if(!key){
        return reply(sock,jid,
`╭─〔 ${g[0]} ${g[1]} 〕
│
│ 🔎 البحث: ${q}
│
│ ⚠️ بيانات الحساب الحقيقية
│ تحتاج API Key لهذه اللعبة.
│
│ 🔑 المفتاح المطلوب:
│ ${keyName}
│
│ 📌 لا أريد إعطائك بيانات وهمية.
╰────────────────

🌸 SHIBACO GAMING`,m);
      }

      return reply(sock,jid,
`🎮 ${g[1]}

🔎 اللاعب: ${q}

⚙️ المفتاح موجود في config.json
لكن API الخاص بهذه اللعبة يحتاج
طريقة Endpoint مختلفة.

🌸 SHIBACO GAMING`,m);
    }
  }

  if(['سبوتيفاي','اغنية','فنان','البوم'].includes(command)){
    if(!q)return reply(sock,jid,`🎵 استخدم: .${command} اسم الأغنية`,m);

    if(command==='فنان'||command==='البوم'){
      try{
        const url=`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&limit=5`;
        const j=await fetchJSON(url,{
          headers:{
            'User-Agent':'Mozilla/5.0',
            'Accept':'application/json'
          }
        },3);

        const results=Array.isArray(j?.results)?j.results:[];

        if(!results.length)
          return reply(sock,jid,'❌ لم أجد نتائج لهذا البحث.',m);

        let text='🎵 SHIBACO MUSIC\n\n';

        results.slice(0,5).forEach((r,i)=>{
          text+=`╭─〔 🎧 ${i+1} 〕\n`;
          text+=`│ 🎵 ${r.trackName||r.collectionName||'غير معروف'}\n`;
          text+=`│ 🎤 ${r.artistName||'غير معروف'}\n`;
          if(r.collectionName)text+=`│ 💿 ${r.collectionName}\n`;
          if(r.trackViewUrl)text+=`│ 🔗 ${r.trackViewUrl}\n`;
          text+='╰──────────────\n\n';
        });

        return reply(sock,jid,text+'🌸 SHIBACO BOT',m);
      }catch(e){
        console.log('MUSIC SEARCH ERROR:',e.message);
        return reply(sock,jid,'❌ تعذر البحث عن الموسيقى الآن.',m);
      }
    }

    let outFile=null;

    try{
      await reply(sock,jid,
`🎵 SHIBACO MUSIC

🔎 البحث: ${q}
⏳ جاري البحث عن الأغنية وتحويلها إلى MP3...`,m);

      const tmpBase=path.join(
        require('os').tmpdir(),
        `shibaco-${Date.now()}`
      );

      const args=[
        `ytsearch1:${q}`,
        '--no-playlist',
        '--no-warnings',
        '--extract-audio',
        '--audio-format','mp3',
        '--audio-quality','128K',
        '--ffmpeg-location','/data/data/com.termux/files/usr/bin',
        '-o',`${tmpBase}.%(ext)s`,
        '--print','after_move:filepath'
      ];

      const file=await new Promise((resolve,reject)=>{
        execFile('yt-dlp',args,{maxBuffer:1024*1024*10},(error,stdout,stderr)=>{
          if(error){
            console.log('YTDLP ERROR:',stderr||error.message);
            return reject(error);
          }

          const lines=String(stdout||'')
            .split(/\r?\n/)
            .map(x=>x.trim())
            .filter(Boolean);

          const found=lines.find(x=>x.endsWith('.mp3'));

          if(!found)return reject(new Error('MP3 file not found'));
          resolve(found);
        });
      });

      outFile=file;

      if(!fs.existsSync(outFile))
        throw new Error('MP3 file does not exist');

      const size=fs.statSync(outFile).size;

      if(!size)
        throw new Error('Empty MP3');

      await sock.sendMessage(jid,{
        audio:{url:outFile},
        mimetype:'audio/mpeg',
        fileName:`${q}.mp3`,
        ptt:false
      },{quoted:m});

      console.log('MP3 SENT:',outFile);

    }catch(e){
      console.log('MP3 ERROR:',e.message);

      await reply(sock,jid,
`❌ فشل تحميل الأغنية.

🎵 ${q}
⚠️ yt-dlp لم يستطع الحصول على الصوت.
📋 الخطأ: ${e.message}`,m);

    }finally{
      if(outFile){
        try{fs.unlinkSync(outFile)}catch{}
      }
    }
  }

  if(command==='صورة'){
    if(!q)return reply(sock,jid,'🖼️ استخدم: .صورة اسم 3',m);
    const bits=q.split(/\s+/);const count=/^\d+$/.test(bits.at(-1)||'')?Number(bits.pop()):1;const query=bits.join(' ').trim()||'anime';
    try{return await sendImageResults(sock,jid,m,query,count);}catch(e){return reply(sock,jid,'❌ تعذر البحث عن الصور الآن.',m);}
  }
  if(command==='ستيكر'){
    try{let img=m.message?.imageMessage?await downloadImageMessage(m):null;const qmsg=quotedMessage(m);if(!img&&qmsg?.imageMessage)img=await downloadImageMessage({message:qmsg});if(!img)return reply(sock,jid,'🖼️ رد على صورة ثم اكتب .ستيكر',m);return await sendStickerFromImage(sock,jid,m,img);}catch(e){return reply(sock,jid,'❌ تعذر إنشاء الملصق. أرسل صورة واضحة أو رد على صورة ثم اكتب .ستيكر',m);}
  }

  async function autoStickerPack(search){
    const safe=search.normalize('NFKC')
      .replace(/[^\w\u0600-\u06FF\u4E00-\u9FFF -]/g,'')
      .trim().replace(/\s+/g,'-').slice(0,60).toLowerCase();

    const dir=path.join(process.cwd(),'stickers',safe);
    fs.mkdirSync(dir,{recursive:true});

    let files=fs.readdirSync(dir)
      .filter(x=>/\.(png|jpg|jpeg|webp)$/i.test(x));

    if(files.length>=3)return {dir,files};

    const aliases={
      'ميسي':['messi','lionel messi'],
      'غوكو':['goku','son goku','dragon ball goku'],
      'ليفاي':['levi','levi ackerman','attack on titan levi'],
      'ناروتو':['naruto','naruto uzumaki'],
      'ساسكي':['sasuke','sasuke uchiha'],
      'لوفي':['luffy','monkey d luffy','one piece luffy'],
      'زورو':['zoro','roronoa zoro'],
      'سانجي':['sanji','one piece sanji'],
      'فيجيتا':['vegeta','dragon ball vegeta'],
      'غوهان':['gohan','dragon ball gohan'],
      'ايتاتشي':['itachi','itachi uchiha'],
      'مادارا':['madara','madara uchiha'],
      'رونالدو':['ronaldo','cristiano ronaldo'],
      'قط':['cat','funny cat'],
      'كلب':['dog','funny dog'],
      'سمكة':['fish','funny fish']
    };

    const qs=aliases[search.toLowerCase()]||[
      search,
      search+' sticker',
      search+' meme'
    ];

    const headers={
      'User-Agent':'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36',
      'Accept':'application/json'
    };

    let downloaded=files.length;

    for(const q of qs){
      if(downloaded>=10)break;

      try{
        const url='https://api.mojilala.com/v1/stickers/search?'+
          new URLSearchParams({
            q:q,
            limit:'30',
            api_key:'dc6zaTOxFJmzC'
          }).toString();

        const r=await fetch(url,{headers});
        if(!r.ok)continue;

        const j=await r.json();
        const data=Array.isArray(j?.data)?j.data:[];

        for(const item of data){
          if(downloaded>=10)break;

          const imgs=item?.images||{};
          const candidates=[
            imgs.fixed_height_still?.url,
            imgs.fixed_height?.url,
            imgs.fixed_width_still?.url,
            imgs.fixed_width?.url,
            imgs.fixed_height?.webp,
            imgs.fixed_width?.webp
          ].filter(Boolean);

          for(const u of candidates){
            try{
              const rr=await fetch(u,{headers});
              if(!rr.ok)continue;

              const type=String(rr.headers.get('content-type')||'').toLowerCase();
              const b=Buffer.from(await rr.arrayBuffer());

              if(b.length<1000)continue;
              if(!type.includes('image'))continue;

              downloaded++;
              const ext=type.includes('webp')?'.webp':
                type.includes('jpeg')?'.jpg':'.png';

              const out=path.join(
                dir,
                String(downloaded).padStart(3,'0')+ext
              );

              fs.writeFileSync(out,b);
              break;
            }catch{}
          }
        }
      }catch(e){
        console.log('STICKER API:',e?.message||e);
      }
    }

    files=fs.readdirSync(dir)
      .filter(x=>/\.(png|jpg|jpeg|webp)$/i.test(x));

    if(!files.length){
      throw new Error('لم يتم العثور على ملصقات من المصادر');
    }

    return {dir,files};
  }

  if(command==='ملصق'){
    if(!q)return reply(sock,jid,'🧩 استخدم: .ملصق غوكو 5',m);

    const parts=q.trim().split(/\s+/);
    let count=1;

    if(/^\d+$/.test(parts.at(-1)||'')){
      count=Math.max(1,Math.min(10,Number(parts.pop())));
    }

    const query=parts.join(' ').trim();

    if(!query){
      return reply(sock,jid,'🧩 استخدم: .ملصق اسم 5',m);
    }

    const aliases={
      'غوكو':['Goku','Son Goku','Dragon Ball Goku'],
      'غوكو سوبر':['Goku Super','Ultra Instinct Goku'],
      'غوكو غريزة':['Ultra Instinct Goku'],
      'ليفاي':['Levi Ackerman','Levi Attack on Titan'],
      'ليفاي اكرمان':['Levi Ackerman'],
      'ناروتو':['Naruto Uzumaki','Naruto'],
      'ساسكي':['Sasuke Uchiha','Sasuke'],
      'كاكاشي':['Kakashi Hatake','Kakashi'],
      'لوفي':['Monkey D Luffy','Luffy One Piece'],
      'زورو':['Roronoa Zoro','Zoro One Piece'],
      'سانجي':['Sanji One Piece','Sanji'],
      'فيجيتا':['Vegeta Dragon Ball','Vegeta'],
      'غوهان':['Gohan Dragon Ball','Gohan'],
      'ايتاتشي':['Itachi Uchiha','Itachi'],
      'مادارا':['Madara Uchiha','Madara'],
      'ايس':['Portgas D Ace','Ace One Piece'],
      'ميسي':['Lionel Messi','Messi'],
      'رونالدو':['Cristiano Ronaldo','Ronaldo'],
      'سمكة':['fish','funny fish'],
      'قط':['cat','funny cat'],
      'كلب':['dog','funny dog']
    };

    const searches=aliases[query.toLowerCase()]||[
      query,
      query+' character',
      query+' funny'
    ];

    const safe=query
      .normalize('NFKC')
      .replace(/[^\w\u0600-\u06FF\u4E00-\u9FFF -]/g,'')
      .trim()
      .replace(/\s+/g,'-')
      .slice(0,60)
      .toLowerCase();

    const dir=path.join(process.cwd(),'stickers',safe);
    fs.mkdirSync(dir,{recursive:true});

    try{
      let files=fs.readdirSync(dir)
        .filter(x=>/\.(png|jpg|jpeg|webp)$/i.test(x));

      /*
       * إذا عندنا Pack/صور محفوظة، نستخدمها مباشرة.
       */
      if(files.length<count){

        let results=[];

        for(const term of searches){
          try{
            const api=
              'https://commons.wikimedia.org/w/api.php?' +
              'action=query&generator=search' +
              '&gsrsearch='+encodeURIComponent(term) +
              '&gsrnamespace=6' +
              '&gsrlimit=20' +
              '&prop=imageinfo' +
              '&iiprop=url|mime' +
              '&iiurlwidth=1000' +
              '&format=json&origin=*';

            const r=await fetch(api,{
              headers:{
                'User-Agent':'SHIBACO-BOT/12 StickerSearch'
              }
            });

            if(!r.ok)continue;

            const j=await r.json();

            const found=Object.values(j?.query?.pages||{})
              .map(x=>({
                title:x.title,
                url:x.imageinfo?.[0]?.thumburl||x.imageinfo?.[0]?.url,
                mime:x.imageinfo?.[0]?.mime||''
              }))
              .filter(x=>
                x.url &&
                /^image\//i.test(x.mime)
              );

            results.push(...found);

            if(results.length>=count*4)break;

          }catch(e){
            console.log('STICKER SEARCH:',e.message||e);
          }
        }

        const unique=[];
        const seen=new Set();

        for(const r of results){
          if(!seen.has(r.url)){
            seen.add(r.url);
            unique.push(r);
          }
        }

        let n=files.length;

        for(const r of unique){
          if(n>=10)break;

          try{
            const b=await fetchBuffer(
              r.url,
              12*1024*1024
            );

            if(!b||b.length<1000)continue;

            const tmp=path.join(
              dir,
              `_source_${Date.now()}_${n}.jpg`
            );

            fs.writeFileSync(tmp,b);

            const out=path.join(
              dir,
              String(++n).padStart(3,'0')+'.webp'
            );

            await execFileAsync(
              ffmpegPath(),
              [
                '-y',
                '-i',tmp,
                '-vf',
                'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0',
                '-vcodec','libwebp',
                '-lossless','0',
                '-q:v','65',
                '-loop','0',
                '-an',
                out
              ],
              {timeout:60000}
            );

            try{fs.unlinkSync(tmp)}catch{}

          }catch(e){
            console.log('STICKER CONVERT:',e.message||e);
          }
        }

        files=fs.readdirSync(dir)
          .filter(x=>/\.(png|jpg|jpeg|webp)$/i.test(x));
      }

      if(!files.length){
        return reply(
          sock,
          jid,
          `❌ ما لقيت صور لـ ${query} حالياً.`,
          m
        );
      }

      const chosen=files
        .sort(()=>Math.random()-0.5)
        .slice(0,count);

      let sent=0;

      for(const file of chosen){
        try{
          const b=fs.readFileSync(
            path.join(dir,file)
          );

          await sendStickerFromImage(
            sock,
            jid,
            m,
            b
          );

          sent++;

          await new Promise(r=>setTimeout(r,350));

        }catch(e){
          console.log(
            'STICKER SEND:',
            e.message||e
          );
        }
      }

      if(!sent){
        return reply(
          sock,
          jid,
          '❌ تعذر إرسال الملصقات.',
          m
        );
      }

    }catch(e){
      console.log(
        'STICKER FINAL:',
        e.message||e
      );

      return reply(
        sock,
        jid,
        `❌ تعذر إنشاء ملصقات لـ ${query}.`,
        m
      );
    }

    return;
  }

  const mediaCommand={mp4:'mp4',فيديو:'mp4',تحميل:'mp4',يوتيوب:'mp4',فيسبوك:'mp4',تيكتوك:'mp4',mp3:'mp3',صوت:'mp3'};
  if(mediaCommand[command]){
    if(!mediaUrl(q))return reply(sock,jid,`❌ اكتب الرابط بعد .${command}`,m);
    try{await reply(sock,jid,`⏳ جاري تجهيز ${mediaCommand[command].toUpperCase()}...`,m);const f=await shibacoDownload(q,mediaCommand[command]);const b=fs.readFileSync(f);if(mediaCommand[command]==='mp3')await sock.sendMessage(jid,{audio:b,mimetype:'audio/mpeg',fileName:'SHIBACO.mp3'},{quoted:m});else await sock.sendMessage(jid,{video:b,mimetype:'video/mp4',fileName:'SHIBACO.mp4'},{quoted:m});try{fs.unlinkSync(f)}catch{}}catch(e){return reply(sock,jid,'❌ تعذر التحميل.\n'+String(e.message||e).slice(0,500),m);}return;
  }
  if(command==='تيك'||command==='تيك_بحث'||command==='ايديت'||command==='ايديت_بحث'){
    if(!q)return reply(sock,jid,command.startsWith('ايديت')?'❌ اكتب اسم الشخصية بعد .ايديت':'❌ اكتب كلمة البحث بعد .تيك',m);
    try{await reply(sock,jid,'🔎 جاري البحث وإرسال الفيديوهات...',m);const search=command.startsWith('ايديت')?`${q} edit anime`:q;const rs=await tikwmSearch(search,6);return sendSearchVideos(sock,jid,m,rs,command.startsWith('ايديت')?`إيدتات ${q}`:`TikTok: ${q}`);}catch(e){return reply(sock,jid,'❌ تعذر تحميل فيديوهات البحث الآن. جرّب كلمة أخرى.',m);}
  }

  const grp=isGroup(jid);const g=grp?group(jid):null;const admin=grp&&canAdmin(meta,sender);const botAdmin=grp&&isBotAdmin(meta,sock);
  if(command==='اوامر'){if(fs.existsSync(MENU_IMAGE))await sock.sendMessage(jid,{image:fs.readFileSync(MENU_IMAGE)},{quoted:m});return reply(sock,jid,mainMenu(),m);}
  if(command==='مساعدة')return reply(sock,jid,help(q),m);
  if(SECTIONS[command])return reply(sock,jid,section(SECTIONS[command].title,SECTIONS[command].commands),m);

  if(command==='بوت'||command==='معلومات')return reply(sock,jid,box('🌸 SHIBACO BOT',`│ 🟢 الحالة: ONLINE\n│ 📦 الإصدار: 1.0\n│ 📌 البادئة: ${PREFIX}\n│ 🎌 Anime: ONLINE\n│ 🤖 AI: ${CONFIG.geminiKey?'🟢':'🔴'}\n│ ⭐ XP: ONLINE\n│ 💰 Economy: ONLINE\n│ 📊 Interaction: ONLINE\n│ 🛡️ Protection: ONLINE`),m);
  if(command==='سرعة')return reply(sock,jid,`⚡ SHIBACO PING: ${Math.max(0,Date.now()-Number(m.messageTimestamp||0)*1000)}ms`,m);
  if(command==='المطور')return reply(sock,jid,box('👑 SHIBACO DEVELOPERS',`│ 👨‍💻 المطور 1: +212788826407\n│ 👨‍💻 المطور 2: +212689100503\n│ 🌸 SHIBACO BOT`),m);
  if(command==='وقت')return reply(sock,jid,'🕐 الوقت: '+new Date().toLocaleString('ar-MA'),m);
  if(command==='اصدار')return reply(sock,jid,'📦 SHIBACO BOT 1.0',m);
  if(command==='اعدادات')return reply(sock,jid,`⚙️ Prefix: ${PREFIX}\n🌸 Name: ${CONFIG.botName}\n🤖 AI: ${CONFIG.geminiKey?'ON':'OFF'}`,m);
  if(command==='معلومات_القروب'){if(!grp)return reply(sock,jid,'❌ للمجموعات فقط.',m);return reply(sock,jid,box('👥 GROUP INFO',`│ 📝 الاسم: ${meta.subject}\n│ 👤 الأعضاء: ${meta.participants.length}\n│ 👑 المشرفون: ${meta.participants.filter(p=>p.admin).length}\n│ 🤖 SHIBACO: ${botAdmin?'مشرف':'عضو'}`),m);}

  if(['لوحتي','لفلي','مستوى','اكسبي','احصائيات'].includes(command))return sock.sendMessage(jid,{text:box('⭐ SHIBACO PROFILE',`│ 👤 @${nameOf(sender)}\n│ ⭐ Level: ${level(u)}\n│ ✨ XP: ${u.xp} / ${xpNext(u)}\n│ 💬 الرسائل: ${u.messages}\n│ 🏆 الفوز: ${u.wins}\n│ 💀 الخسارة: ${u.losses}\n│ 💵 الكاش: $${money(u.money)}\n│ 🏦 البنك: $${money(u.bank)}\n│ 💎 الجواهر: ${u.gems}`),mentions:[sender]},{quoted:m});
  if(command==='ترتيب'||command==='توب'){const z=Object.entries(db.users).sort((a,b)=>b[1].xp-a[1].xp).slice(0,10);return sock.sendMessage(jid,{text:box('🏆 SHIBACO TOP',z.length?z.map(([id,x],i)=>`│ ${i+1}️⃣ @${nameOf(id)} — Lv.${level(x)} — ${x.xp} XP`).join('\n'):'│ لا توجد بيانات.'),mentions:z.map(x=>x[0])},{quoted:m});}
  if(command==='جوائز'||command==='مكافأة')return reply(sock,jid,'🎁 الجوائز: كل مستوى جديد يعطيك +100 💰 و+1 💎 عند الوصول إليه.',m);
  if(command==='تطوير')return reply(sock,jid,'⭐ كل 500 XP = مستوى جديد.\n💡 رسائل المجموعة تمنح XP مرة كل دقيقة.',m);

  if(['التفاعل','توب_التفاعل','ترتيب_التفاعل','نشاط_القروب','احصائيات_القروب','اكثر_شخص','اقل_شخص'].includes(command)){if(!grp)return reply(sock,jid,'❌ هذا الأمر للمجموعات فقط.',m);const z=Object.entries(g.interaction).sort((a,b)=>b[1]-a[1]);if(!z.length)return reply(sock,jid,'📊 لا توجد بيانات تفاعل حتى الآن.',m);let list=z.slice(0,20);if(command==='اقل_شخص')list=z.slice(-10).reverse();if(command==='اكثر_شخص')list=z.slice(0,1);return sock.sendMessage(jid,{text:box('📊 SHIBACO INTERACTION',list.map(([id,n],i)=>`│ ${i+1}️⃣ @${nameOf(id)}\n│ 💬 ${n} رسالة`).join('\n\n')),mentions:list.map(x=>x[0])},{quoted:m});}
  if(command==='رسائلي'||command==='نشاطي')return reply(sock,jid,`📊 @${nameOf(sender)} لديك ${u.messages} رسالة.`,m,[sender]);
  if(command==='تجديد_التفاعل'){if(!grp||!admin)return reply(sock,jid,'❌ للمشرفين داخل المجموعات فقط.',m);g.interaction={};saveDB();return reply(sock,jid,'♻️ تم تجديد تفاعل الجميع.\n⭐ XP والمستويات والاقتصاد لم تتغير.',m);}

  if(command==='رصيد'||command==='بنك'||command==='ثروتي')return reply(sock,jid,box('💰 SHIBACO BANK',`│ 💵 المحفظة: $${money(u.money)}\n│ 🏦 البنك: $${money(u.bank)}\n│ 💎 الجواهر: ${u.gems}\n│ 🏆 الثروة: $${money(u.money+u.bank)}`),m);
  if(command==='ايداع'||command==='سحب'){const n=Number(args[0]);if(!Number.isInteger(n)||n<1)return reply(sock,jid,`❌ استخدم: .${command} 500`,m);if(command==='ايداع'){if(n>u.money)return reply(sock,jid,'❌ المحفظة لا تكفي.',m);u.money-=n;u.bank+=n;}else{if(n>u.bank)return reply(sock,jid,'❌ البنك لا يكفي.',m);u.bank-=n;u.money+=n;}saveDB();return reply(sock,jid,`✅ تمت العملية: $${money(n)}`,m);}
  if(command==='تحويل'){const t=mentioned(m),n=Number(args.find(x=>/^\d+$/.test(x))||0);if(!t||!n)return reply(sock,jid,'❌ استخدم: .تحويل @عضو 500',m);if(n>u.money)return reply(sock,jid,'❌ رصيدك لا يكفي.',m);u.money-=n;user(t).money+=n;saveDB();return reply(sock,jid,`💸 تم تحويل $${money(n)} إلى @${nameOf(t)}`,m,[t]);}
  if(command==='يومي'){if(Date.now()-u.daily<86400000)return reply(sock,jid,'⏳ أخذت اليومية بالفعل، عد غداً.',m);const n=1000+Math.floor(Math.random()*2001);u.money+=n;u.gems+=2;u.daily=Date.now();saveDB();return reply(sock,jid,`🎁 اليومية: +$${money(n)} و +2 💎`,m);}
  if(command==='عمل'){if(Date.now()-u.work<3600000)return reply(sock,jid,'⏳ العمل مرة كل ساعة.',m);const n=300+Math.floor(Math.random()*1201);u.money+=n;u.work=Date.now();saveDB();return reply(sock,jid,`💼 ربحت $${money(n)} من العمل.`,m);}
  if(command==='متجر')return reply(sock,jid,box('🛒 SHIBACO STORE','│ 1️⃣ 🎁 صندوق الحظ — $5,000\n│ 2️⃣ ⭐ 500 XP — $10,000\n│ 3️⃣ 💎 10 جواهر — $15,000\n│\n│ 🛒 .شراء 1'),m);
  if(command==='شراء'){const i=args[0];if(i==='1'){if(u.money<5000)return reply(sock,jid,'❌ لا يكفي.',m);u.money-=5000;const n=1000+Math.floor(Math.random()*9001);u.money+=n;saveDB();return reply(sock,jid,`🎁 فتحت الصندوق وربحت $${money(n)}!`,m);}if(i==='2'){if(u.money<10000)return reply(sock,jid,'❌ لا يكفي.',m);u.money-=10000;u.xp+=500;saveDB();return reply(sock,jid,'⭐ +500 XP!',m);}if(i==='3'){if(u.money<15000)return reply(sock,jid,'❌ لا يكفي.',m);u.money-=15000;u.gems+=10;saveDB();return reply(sock,jid,'💎 +10 جواهر!',m);}return reply(sock,jid,'❌ اختر 1 أو 2 أو 3.',m);}

  {
    const GAME_COMMANDS=new Set([
      'اكس_او','اربع_على_سطر','السفينة_الحربية','حقل_الالغام',
      'تفبيك_القنبلة','الهروب_من_السجن','سؤال_وخبرة','سرقة_XP',
      'شجرة_المهارات','ترتيب_الخبرة','عجلة_الحظ','كلمة_السر',
      'من_هو_اللاعب','تخمين_الاعلام','تحدي_السرعة','صيد_الوحوش',
      'قتال_البارون','المتاهة','احزر_الايموجي','حبل_المشنقة',
      'لو_خيروك','مظلوم_او_ظالم','re'
    ]);
    {
      const gh=require('./games-handler');
      const active=require('./games').GAMES;
      const hasGame=[...active.keys()].some(k=>k.startsWith(jid+'|'));
      if(GAME_COMMANDS.has(command)||hasGame){
        const gr=gh({
          command,args,m,jid,sender,u,user,saveDB,mentioned,nameOf,
          reply:(text,mentions=[])=>reply(sock,jid,text,m,mentions)
        });
        if(gr)return gr;
      }
    }
  }

  if(command==='انمي'||command==='بحث_انمي')return animeSearch(sock,jid,q,m);
  if(command==='انمي_عشوائي')return animeSearch(sock,jid,ANIME_NAMES[Math.floor(Math.random()*ANIME_NAMES.length)],m);
  if(command==='شخصية'||command==='معلومات_شخصية')return characterSearch(sock,jid,q,m);
  if(command==='صورة_انمي'){
  if(!q)return reply(sock,jid,'🖼️ استخدم: .صورة_انمي غوكو',m);
  try{return await sendImageResults(sock,jid,m,q,3);}
  catch(e){return reply(sock,jid,'❌ تعذر جلب صور الأنمي الآن.',m);}
}
  if(command==='اقتباس_انمي'){
  const quotes=[
    '✨ لا تستسلم قبل أن تبدأ، واصنع قصتك بنفسك.',
    '🔥 القوة الحقيقية تظهر عندما ترفض الاستسلام.',
    '⚔️ حتى أضعف شخص يمكنه تغيير مصيره.'
  ];
  return reply(sock,jid,quotes[Math.floor(Math.random()*quotes.length)],m);
}
  if(command==='مانجا'||command==='بحث_مانجا')return mangaSearch(sock,jid,q,m);
  if(command==='موسم_الانمي')return currentAnimeSeason(sock,jid,m);
  if(command==='اخبار_انمي')return animeNews(sock,jid,m);

  if(command==='شخصيتي'||command==='بطاقتي')return reply(sock,jid,box('👤 MY CHARACTER',`│ @${nameOf(sender)}\n│ 🎌 الشخصية: ${u.anime}\n│ ⭐ المستوى: ${level(u)}\n│ 💬 الرسائل: ${u.messages}`),m,[sender]);
  if(command==='اختار_شخصية'){const chars=['ليفاي','غوجو','ناروتو','لوفي','إيتاتشي','تانجيرو','ميكاسا'];u.anime=chars[Math.floor(Math.random()*chars.length)];saveDB();return reply(sock,jid,`👤 شخصيتك الجديدة: ${u.anime}`,m);}
  if(command==='تغيير_شخصية'){if(!q)return reply(sock,jid,'اكتب اسم الشخصية.',m);u.anime=q;saveDB();return reply(sock,jid,`✅ شخصيتك أصبحت: ${q}`,m);}
  if(command==='حب_شخصية'||command==='حب')return reply(sock,jid,`💜 نسبة حبك لشخصيتك ${u.anime}: ${Math.floor(Math.random()*101)}%`,m);
  if(command==='زواج'){const t=mentioned(m);if(!t)return reply(sock,jid,'💍 استخدم .زواج @عضو',m);return reply(sock,jid,`💍 @${nameOf(sender)} و @${nameOf(t)} أعلنّا الزواج داخل SHIBACO 💜`,m,[sender,t]);}
  if(command==='طلاق')return reply(sock,jid,'💔 تم تسجيل الطلاق الافتراضي 😂',m);
  if(command==='توافق')return reply(sock,jid,`💞 نسبة التوافق: ${Math.floor(Math.random()*101)}%`,m);

  if(command==='نكتة')return reply(sock,jid,JOKES[Math.floor(Math.random()*JOKES.length)],m);
  if(command==='معلومة')return reply(sock,jid,FACTS[Math.floor(Math.random()*FACTS.length)],m);
  if(command==='سؤال')return reply(sock,jid,QUESTIONS[Math.floor(Math.random()*QUESTIONS.length)],m);
  if(command==='صراحة')return reply(sock,jid,'🗣️ صراحة: ما أكثر شيء تريد تغييره في نفسك؟',m);
  if(command==='جرأة')return reply(sock,jid,'🔥 جرأة: أرسل آخر صورة في معرضك لصديقك المقرب 😂',m);
  if(command==='اختار'){const opts=q.split(/[،,]/).map(x=>x.trim()).filter(Boolean);if(opts.length<2)return reply(sock,jid,'❌ استخدم: .اختار بيتزا، برجر، شاورما',m);return reply(sock,jid,'🎲 اخترت لك: '+opts[Math.floor(Math.random()*opts.length)],m);}
  if(command==='احزر')return reply(sock,jid,'🕵️ خمن: ما الشخصية التي أفكر فيها؟\n💡 تلميح: شخصية أنمي.',m);
  if(command==='فرفشة')return reply(sock,jid,'🎉 فرفشة SHIBACO: أنت أسطورة حتى يثبت العكس 😂🔥',m);
  if(command==='ميم')return reply(sock,jid,'😂 ميم اليوم: لما تقول البوت شغال ويطلع لك Bad MAC.',m);
  if(command==='حكم')return reply(sock,jid,'🧠 حكمة: الاستمرار أقوى من البداية المثالية.',m);
  if(command==='كلمة_سر')return reply(sock,jid,'🔐 كلمة السر السرية اليوم: SHIBACO.',m);
  if(command==='من_يشبهني')return reply(sock,jid,`🎭 حسب الحظ أنت تشبه ${['ليفاي','غوجو','ناروتو','لوفي','غوكو'][Math.floor(Math.random()*5)]}!`,m);
  if(command==='عشوائي')return reply(sock,jid,`🎲 اختيار عشوائي: ${Math.floor(Math.random()*100)+1}`,m);

  if(['ai','اسأل','محادثة','شخصية_ai','ترجم','لخص','اكتب','صحح','برمج'].includes(command)){
    try{
      const mode={ترجم:'translate',لخص:'summarize',اكتب:'write',صحح:'correct',برمج:'code'}[command]||'chat';
      if(command==='شخصية_ai')u.aiCharacter=q||u.aiCharacter;
      const answer=await askAI(command==='شخصية_ai'?'تحدث معي كشخصية '+u.aiCharacter:q||'مرحبا',u.aiCharacter,mode);saveDB();return reply(sock,jid,box('🤖 SHIBACO AI',answer),m);
    }catch(e){return reply(sock,jid,'❌ AI: '+String(e.message||e).slice(0,500),m);}
  }
  if(command==='مسح_محادثة'){u.aiCharacter='مساعد SHIBACO';saveDB();return reply(sock,jid,'♻️ تم مسح إعداد شخصية AI الخاصة بك.',m);}

  const adminCommands=['طرد','حظر','فك_الحظر','ترقية','تنزيل','مسح','قفل','فتح','منشن','تحذير','تحذيرات','صفر_تحذيرات','حماية','مضاد_الروابط','مضاد_السبام','مضاد_التكرار','مضاد_المنشن','مضاد_السب','قائمة_الحماية','اعدادات_الحماية','ق8'];

  if(adminCommands.includes(command)){
    if(!grp)return reply(sock,jid,'❌ هذا الأمر للمجموعات فقط.',m);

    // تحديث بيانات المجموعة مباشرة لتجنب مشكلة LID/JID
    let gm;
    try{
      gm=await sock.groupMetadata(jid);
    }catch(e){
      return reply(sock,jid,'❌ تعذر جلب بيانات المجموعة.',m);
    }

    const participants=gm.participants||[];
    const findParticipant=(who)=>{
      if(!who)return null;
      return participants.find(p=>{
        const ids=[p.id,p.jid,p.phoneNumber,p.lid].filter(Boolean);
        return ids.some(x=>{
          try{return areJidsSameUser(String(x),String(who));}
          catch{return String(x)===String(who);}
        });
      })||null;
    };

    const senderP=findParticipant(sender);
    const botIds=[
      sock.user?.id,
      sock.user?.lid,
      sock.user?.jid
    ].filter(Boolean);

    const botP=participants.find(p=>{
      const ids=[p.id,p.jid,p.phoneNumber,p.lid].filter(Boolean);
      return ids.some(x=>botIds.some(b=>{
        try{return areJidsSameUser(String(x),String(b));}
        catch{return String(x)===String(b);}
      }));
    })||null;

    const admin=!!(senderP&&(senderP.admin==='admin'||senderP.admin==='superadmin'));
    const botAdmin=!!(botP&&(botP.admin==='admin'||botP.admin==='superadmin'));

    if(!admin)return reply(sock,jid,'❌ هذا الأمر للمشرفين فقط.',m);

    if(['قفل','فتح','طرد','حظر','فك_الحظر','ترقية','تنزيل','مسح'].includes(command)&&!botAdmin){
      return reply(sock,jid,'❌ SHIBACO لازم يكون مشرفاً لتنفيذ هذا الأمر.',m);
    }

    if(command==='قفل'||command==='فتح'){
      await sock.groupSettingUpdate(
        jid,
        command==='قفل'?'announcement':'not_announcement'
      );
      return reply(sock,jid,
        command==='قفل'?'🔒 تم قفل المجموعة.':'🔓 تم فتح المجموعة.',
        m
      );
    }

    if(['ترقية','تنزيل','طرد','حظر','فك_الحظر'].includes(command)){
      const t=mentioned(m);
      if(!t)return reply(sock,jid,`❌ استخدم .${command} @عضو`,m);

      const tp=findParticipant(t);
      const target=tp?.id||t;

      if(sameJid(target,sender))
        return reply(sock,jid,'❌ لا تستخدم الأمر على نفسك.',m);

      const act=
        command==='ترقية'?'promote':
        command==='تنزيل'?'demote':
        command==='فك_الحظر'?'add':'remove';

      try{
        await sock.groupParticipantsUpdate(jid,[target],act);
        return reply(
          sock,jid,
          `✅ تمت عملية ${command} لـ @${nameOf(target)}`,
          m,[target]
        );
      }catch(e){
        return reply(sock,jid,'❌ فشلت العملية: '+String(e?.message||e).slice(0,250),m);
      }
    }

    if(command==='مسح'){
      if(!grp){
        return;
      }

      const count=Math.max(1,Math.min(parseInt(args[0]||'1',10)||1,50));
      const history=SHIBACO_MESSAGE_HISTORY.get(jid)||[];

      // استبعاد رسالة الأمر الحالية حتى لا تُحسب ضمن العدد
      const available=history.filter(x=>x.id!==m.key.id);

      if(available.length===0){
        return;
      }

      // آخر N رسائل قبل أمر .مسح
      const targets=available.slice(-count).reverse();

      for(const item of targets){
        try{
          await sock.sendMessage(jid,{
            delete:{
              remoteJid:item.remoteJid||jid,
              fromMe:!!item.fromMe,
              id:item.id,
              participant:item.participant||undefined
            }
          });
        }catch(e){
          console.log('DELETE ERROR:',e?.message||e);
        }
      }

      const deletedIds=new Set(targets.map(x=>x.id));

      SHIBACO_MESSAGE_HISTORY.set(
        jid,
        history.filter(x=>!deletedIds.has(x.id))
      );

      return;
    }

    if(command==='منشن'){
      const ids=participants
        .map(p=>p.id||p.jid)
        .filter(Boolean);

      return sock.sendMessage(
        jid,
        {
          text:'📢 SHIBACO MENTION\n'+ids.map(x=>'@'+nameOf(x)).join(' '),
          mentions:ids
        },
        {quoted:m}
      );
    }

    if(command==='تحذير'){
      const t=mentioned(m);
      if(!t)return reply(sock,jid,'❌ استخدم .تحذير @عضو',m);

      const tu=user(t);
      tu.warnings++;
      saveDB();

      if(tu.warnings>=3&&botAdmin){
        await sock.groupParticipantsUpdate(jid,[t],'remove').catch(()=>{});
        tu.warnings=0;
        saveDB();
        return reply(
          sock,jid,
          `🚨 @${nameOf(t)} وصل 3 تحذيرات وتم إخراجه.`,
          m,[t]
        );
      }

      return reply(
        sock,jid,
        `⚠️ @${nameOf(t)} — ${tu.warnings}/3 تحذيرات`,
        m,[t]
      );
    }

    if(command==='تحذيرات'){
      const t=mentioned(m)||sender;
      return reply(
        sock,jid,
        `⚠️ @${nameOf(t)} لديه ${user(t).warnings} تحذيرات.`,
        m,[t]
      );
    }

    if(command==='صفر_تحذيرات'){
      const t=mentioned(m)||sender;
      user(t).warnings=0;
      saveDB();
      return reply(sock,jid,'♻️ تم تصفير التحذيرات.',m);
    }

    if(command==='حماية'){
      const on=args[0]==='تشغيل';
      g.protection.enabled=on;
      g.protection.links=on;
      g.protection.spam=on;
      g.protection.repeat=on;
      g.protection.mentions=on;
      saveDB();

      return reply(sock,jid,
`🛡️ SHIBACO PROTECTION
│ الحالة: ${on?'🟢 تشغيل':'🔴 إيقاف'}
│ 🔗 الروابط: ${on?'🟢':'🔴'}
│ 💬 السبام: ${on?'🟢':'🔴'}
│ 🔁 التكرار: ${on?'🟢':'🔴'}
│ 📢 المنشن: ${on?'🟢':'🔴'}`,m);
    }

    if(command==='مضاد_السب'){
  g.protection.badWords=args[0]==='تشغيل';
  g.protection.enabled=true;
  saveDB();
  return reply(
    sock,
    jid,
    `🚫 مضاد السب: ${g.protection.badWords?'🟢 تشغيل':'🔴 إيقاف'}`,
    m
  );
}

if(command==='مضاد_الروابط'){
      g.protection.links=args[0]==='تشغيل';
      saveDB();
      return reply(sock,jid,
        `🔗 مضاد الروابط: ${g.protection.links?'🟢 تشغيل':'🔴 إيقاف'}`,m);
    }

    if(command==='مضاد_السبام'){
      g.protection.spam=args[0]==='تشغيل';
      saveDB();
      return reply(sock,jid,
        `💬 مضاد السبام: ${g.protection.spam?'🟢 تشغيل':'🔴 إيقاف'}`,m);
    }

    if(command==='مضاد_التكرار'){
      g.protection.repeat=args[0]==='تشغيل';
      saveDB();
      return reply(sock,jid,
        `🔁 مضاد التكرار: ${g.protection.repeat?'🟢 تشغيل':'🔴 إيقاف'}`,m);
    }

    if(command==='مضاد_المنشن'){
      g.protection.mentions=args[0]==='تشغيل';
      saveDB();
      return reply(sock,jid,
        `📢 مضاد المنشن: ${g.protection.mentions?'🟢 تشغيل':'🔴 إيقاف'}`,m);
    }

    if(command==='قائمة_الحماية'||command==='اعدادات_الحماية'){
      return reply(sock,jid,
        box('🛡️ SHIBACO PROTECTION',
`│ الحماية: ${g.protection.enabled?'🟢':'🔴'}
│ الروابط: ${g.protection.links?'🟢':'🔴'}
│ السبام: ${g.protection.spam?'🟢':'🔴'}
│ التكرار: ${g.protection.repeat?'🟢':'🔴'}
│ المنشن: ${g.protection.mentions?'🟢':'🔴'}
│ السب: ${g.protection.badWords!==false?'🟢':'🔴'}`),m);
    }
  }

  return reply(sock,jid,box('❌ أمر غير موجود',`│ الأمر: ${PREFIX}${command}\n│\n│ لم أجد هذا الأمر في SHIBACO BOT.\n│\n│ 💡 اكتب .اوامر`),m);
}

const SHIBACO_MESSAGE_HISTORY = new Map();

async function start(){
  const {version:waVersion}=await fetchLatestWaWebVersion({});
  const {state,saveCreds}=await useMultiFileAuthState(AUTH_DIR);
  const sock=makeWASocket({
    auth:state,
    logger:P({level:'info'}),
    markOnlineOnConnect:true,
    printQRInTerminal:false,
    syncFullHistory:false,shouldIgnoreJid:(jid)=>false,
    version:waVersion,
    browser:['Chrome','Chrome','1.0']
  });
  sock.ev.on('creds.update',saveCreds);
  sock.ev.on('connection.update',async({connection,lastDisconnect})=>{
    if(connection==='open')console.log('\n🌸 SHIBACO BOT ONLINE — 1\n');
    if(connection==='close'){
      const code=lastDisconnect?.error?.output?.statusCode;
      console.log('DISCONNECT CODE:',code||'unknown'); console.log('DISCONNECT ERROR:',JSON.stringify(lastDisconnect?.error?.output||lastDisconnect?.error||{},null,2));
      if(code!==DisconnectReason.loggedOut)setTimeout(start,4000);else console.log('❌ جلسة واتساب مسجلة خروج.');
    }
  });
  if(!state.creds.registered){
    const number=String(CONFIG.pairingNumber||'').replace(/\D/g,'');
    if(number){
      let pairingBusy=false;
      const requestPairing=async()=>{
        if(state.creds.registered||pairingBusy)return;
        pairingBusy=true;
        try{
          const code=await sock.requestPairingCode(number);
          console.log('\n━━━━━━━━━━━━━━━━━━━━');
          console.log('🔑 كود ربط SHIBACO: '+code);
          console.log('📱 واتساب > الأجهزة المرتبطة > ربط جهاز');
          console.log('⏱️ إذا تأخر الربط، سيتم طلب كود جديد بعد دقيقتين');
          console.log('━━━━━━━━━━━━━━━━━━━━\n');
        }catch(e){
          console.log('❌ فشل إنشاء كود الربط:',e?.message||e);
        }finally{
          pairingBusy=false;
        }
      };
      setTimeout(requestPairing,5000);
      setInterval(requestPairing,120000);
    }else{
      console.log('❌ pairingNumber غير موجود في config.json');
    }
  }

    sock.ev.on('messages.upsert',async({messages})=>{
    console.log('🧪 MESSAGE EVENT:',messages?.length||0);
    for(const m of messages){try{
      if(!m.message||m.key.fromMe)continue;const jid=m.key.remoteJid;if(!jid)continue;const sender=m.key.participant||jid;
      const senderAlt=m.key.participantAlt||m.key.remoteJidAlt||null;const raw=textOf(m);

      if(jid.endsWith('@g.us') && m.key.id){
        const history=SHIBACO_MESSAGE_HISTORY.get(jid)||[];
        if(!history.some(x=>x.id===m.key.id)){
          history.push({
            id:m.key.id,
            remoteJid:jid,
            fromMe:!!m.key.fromMe,
            participant:m.key.participant||m.key.participantAlt||m.key.remoteJidAlt||sender
          });
          while(history.length>50)history.shift();
          SHIBACO_MESSAGE_HISTORY.set(jid,history);
        }
      }console.log('🛡️ PROTECT DEBUG:',{jid, sender, raw, type:Object.keys(m.message||{})});const grp=isGroup(jid);

      if(grp && !raw.startsWith(PREFIX)){
        const history=SHIBACO_MESSAGE_HISTORY.get(jid)||[];
        history.push({
          id:m.key.id,
          remoteJid:jid,
          fromMe:false,
          participant:m.key.participant||m.key.participantAlt||m.key.remoteJidAlt||sender
        });
        while(history.length>50)history.shift();
        SHIBACO_MESSAGE_HISTORY.set(jid,history);
      }let meta=null,g=null,u=user(sender);
      if(grp){
        meta=await sock.groupMetadata(jid);g=group(jid);u.messages++;g.interaction[sender]=(g.interaction[sender]||0)+1;
        const oldLevel=level(u);if(Date.now()-u.lastXP>60000){u.xp+=10;u.lastXP=Date.now();if(level(u)>oldLevel){u.money+=100;u.gems+=1;}}
        const p=g.protection;

        const protectionAdmin=meta?.participants?.some(x=>{
          const admin=x?.admin==='admin'||x?.admin==='superadmin'||x?.admin===true;
          if(!admin)return false;
          return [x?.id,x?.jid,x?.lid,x?.phoneNumber,x?.phone]
            .filter(Boolean)
            .some(v=>String(v)===String(sender));
        })||false;

        if(
          (p.enabled||p.links||p.spam||p.repeat||p.mentions||p.badWords) &&
          !protectionAdmin
        ){

          const now=Date.now();

          g._spam ||= {};
          g._repeat ||= {};

          const recent=(g._spam[sender]||[])
            .filter(x=>now-x.time<10000);

          recent.push({
            time:now,
            key:m.key
          });

          g._spam[sender]=recent;

          const previous=g._repeat[sender]||{};

          const repeated=
            !!raw &&
            String(raw).trim() &&
            String(raw).trim()===String(previous.text||'').trim() &&
            now-(previous.time||0)<15000;

          g._repeat[sender]={
            text:raw,
            time:now
          };

          const link=
            p.links &&
            /(https?:\/\/|http:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/|t\.me\/|discord\.gg\/)/i
            .test(String(raw||''));

          const mention=
            p.mentions &&
            (
              m.message?.extendedTextMessage?.contextInfo?.mentionedJid||[]
            ).length>=5;

          const spam=
            p.spam &&
            recent.length>=3;

          const repeat=
            p.repeat &&
            repeated;

          // كشف السب تلقائيًا مع تجاوز المسافات والرموز وتكرار الحروف
          const badWord=
            p.badWords === true &&
            shibacoBadWordDetected(raw);

          let reason='';

          if(badWord)reason='🚫 كلمة مسيئة';
          else if(link)reason='🔗 إرسال رابط';
          else if(spam)reason='💬 سبام';
          else if(repeat)reason='🔁 تكرار الرسالة';
          else if(mention)reason='📢 منشن جماعي';

          if(reason){

            const botAdmin=isBotAdmin(meta,sock);

            // حذف الرسالة المخالفة — نحاول دائمًا
            await sock.sendMessage(jid,{
              delete:m.key
            }).catch(()=>{});

            // في حالة السبام: حذف آخر رسالتين أيضاً — نحاول دائمًا
            if(spam){

              const oldMessages=recent
                .slice(-3,-1)
                .reverse();

              for(const item of oldMessages){
                if(item?.key){
                  await sock.sendMessage(jid,{
                    delete:item.key
                  }).catch(()=>{});
                }
              }
            }

            // إضافة تحذير
            u.warnings=(Number(u.warnings)||0)+1;

            saveDB();

            // التحذير الثالث = طرد
            if(u.warnings>=3){

              const count=u.warnings;

              try{
                await sock.groupParticipantsUpdate(
                  jid,
                  [sender],
                  'remove'
                );
              }catch{}

              u.warnings=0;
              saveDB();

              await reply(
                sock,
                jid,
                `🚨 SHIBACO SECURITY\n\n`+
                `👤 @${nameOf(sender)}\n`+
                `⚠️ ${reason}\n`+
                `📊 التحذيرات: ${count}/3\n\n`+
                `👢 تم الوصول إلى 3 تحذيرات — تم طرد العضو.`,
                m,
                [sender]
              ).catch(()=>{});

              continue;
            }

            await reply(
              sock,
              jid,
              `⚠️ SHIBACO WARNING\n\n`+
              `👤 @${nameOf(sender)}\n`+
              `${reason}\n`+
              `📊 التحذير: ${u.warnings}/3\n`+
              `🚨 التحذير الثالث = طرد تلقائي.`,
              m,
              [sender]
            ).catch(()=>{});

            continue;
          }
        }
        saveDB();
      }
      {
        const active=require('./games').GAMES;
        const hasGame=[...active.keys()].some(k=>k.startsWith(jid+'|'));
        if(hasGame){
          try{
            const gameMsgId=GAME_MESSAGES.get(jid);

            const quotedId=
              m.message?.extendedTextMessage?.contextInfo?.stanzaId ||
              m.message?.imageMessage?.contextInfo?.stanzaId ||
              m.message?.videoMessage?.contextInfo?.stanzaId;

            if(gameMsgId && quotedId!==gameMsgId){
              continue;
            }

            const gr=require('./game-replies')({
              jid,sender,text:raw,u,user,saveDB,
              nameOf:(id)=>nameOf(id),
              reply:(text,mentions=[])=>reply(sock,jid,text,m,mentions)
            });
            if(gr){
              const activeNow=require('./games').GAMES;

              for(const [gameKey,gameState] of activeNow.entries()){
                if(!gameKey.startsWith(jid+'|'))continue;

                if(gameState && typeof gameState==='object' && !gameState._starter){
                  gameState._starter=sender;
                  gameState._startedAt=Date.now();
                }
              }

              continue;
            }
          }catch(e){console.log('GAME REPLY ERROR:',e.message);}
        }
      }
      if(!raw.startsWith(PREFIX))continue;
      const parts=raw.slice(PREFIX.length).trim().split(/\s+/);
      const command=(parts.shift()||'').toLowerCase();
      if(!command)continue;

      /* إيقاف اللعبة */
      if(command==='ايقاف'){
        const active=require('./games').GAMES;
        const current=[...active.entries()]
          .filter(([k])=>k.startsWith(jid+'|'));

        if(!current.length){
          await reply(sock,jid,'🎮 لا توجد لعبة جارية حاليًا.',m);
          continue;
        }

        let stopped=false;

        for(const [key,state] of current){
          const starter=state?._starter;

          if(
            starter &&
            (sameJid(starter,sender)||sameJid(starter,senderAlt))
          ){
            active.delete(key);
            stopped=true;
          }
        }

        if(stopped){
          await reply(
            sock,
            jid,
            '🛑 تم إيقاف اللعبة بنجاح!\n\n🎮 يمكنك بدء لعبة جديدة الآن.',
            m
          );
        }else{
          await reply(
            sock,
            jid,
            '❌ أنت لست صاحب اللعبة.\n\n👑 فقط صاحب اللعبة يستطيع إيقافها.',
            m
          );
        }

        continue;
      }

      /* منع بدء لعبة جديدة أثناء لعبة جارية */
      {
        const active=require('./games').GAMES;
        const running=[...active.keys()]
          .some(k=>k.startsWith(jid+'|'));

        const GAME_COMMANDS=new Set([
          'اكس_او',
          'اربع_على_سطر',
          'السفينة_الحربية',
          'حقل_الالغام',
          'تفبيك_القنبلة',
          'الهروب_من_السجن',
          'سؤال_وخبرة',
          'سرقة_xp',
          'شجرة_المهارات',
          'ترتيب_الخبرة',
          'عجلة_الحظ',
          'كلمة_السر',
          'من_هو_اللاعب',
          'تخمين_الاعلام',
          'تحدي_السرعة',
          'صيد_الوحوش',
          'قتال_البارون',
          'المتاهة',
          'احزر_الايموجي',
          'حبل_المشنقة',
          'لو_خيروك',
          'مظلوم_او_ظالم'
        ]);

        if(running && GAME_COMMANDS.has(command)){
          await reply(
            sock,
            jid,
            '🎮⚠️ هناك لعبة جارية بالفعل!\n\n' +
            '⏳ انتظر حتى تنتهي اللعبة الحالية.\n' +
            '🛑 صاحب اللعبة يكتب: .ايقاف',
            m
          );
          continue;
        }
      }

      if(command==='re'){
        if(!isOwner(sender,senderAlt,m,jid,meta)){
          await reply(sock,jid,'❌ هذا الأمر للمطورين فقط.',m);
          continue;
        }
        try{
          if(db.users&&typeof db.users==='object'){
            for(const id of Object.keys(db.users)){
              const u=db.users[id]||{};
              u.xp=0;
              u.level=1;
              u.messages=0;
              u.money=1000;
              u.bank=0;
              u.gems=0;
              u.wins=0;
              u.losses=0;
              u.warnings=0;
              u.daily=0;
              u.work=0;
              u.lastXP=0;
              db.users[id]=u;
            }
          }
          saveDB();
          try{require('./games').GAMES.clear();}catch{}
          await reply(sock,jid,
`╭━━━〔 ♻️ SHIBACO RESET 〕━━━╮
│ ⭐ XP: 0
│ 🎚️ المستوى: 1
│ 💬 الرسائل: 0
│ 💰 المال: 1000
│ 🏦 البنك: 0
│ 💎 الجواهر: 0
│ 🏆 الفوز: 0
│ 💀 الخسارة: 0
╰━━━━━━━━━━━━━━━━━━╯
🔒 auth + config لم تتأثر.`,m);
        }catch(e){
          await reply(sock,jid,'❌ فشل تجديد البيانات: '+(e?.message||e),m);
        }
        continue;
      }

      await handle(sock,m,command,parts,jid,sender,meta);
    }catch(e){console.log('ERROR:',e?.stack||e)}}
  });
}
start().catch(console.error);
