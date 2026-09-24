const G=require('./games');

function gamesHandler({command,args,m,jid,sender,u,user,reply,saveDB,mentioned,nameOf}){
  const target=mentioned(m);
  const xp=(n,g)=>{
    u.xp=(u.xp||0)+n;
    u.money=(u.money||0)+g;
    saveDB();
    return `⭐ +${n} XP\n💰 +$${g}`;
  };

  if(command==='اكس_او'){
    if(!target)return reply('❌ استخدم: .اكس_او @عضو');
    if(target===sender)return reply('❌ لا يمكنك اللعب ضد نفسك.');
    G.SET(jid,'xo',{p1:sender,p2:target,b:Array(9).fill(''),turn:sender});
    return reply(
      `🎮 ❌⭕ XO

1️⃣ 2️⃣ 3️⃣
4️⃣ 5️⃣ 6️⃣
7️⃣ 8️⃣ 9️⃣

❌ @${nameOf(sender)}
⭕ @${nameOf(target)}

👉 الدور: @${nameOf(sender)}
✏️ اختر رقمًا من 1 إلى 9`,
      [sender,target]
    );
  }

  if(command==='حقل_الالغام'){
    const bombs=[];
    while(bombs.length<2){
      const n=Math.floor(Math.random()*9)+1;
      if(!bombs.includes(n))bombs.push(n);
    }
    G.SET(jid,'mine',{bombs,used:[],safe:0});
    return reply(`💣 حقل الألغام

اختر خانة من 1 إلى 9:

1️⃣ 2️⃣ 3️⃣
4️⃣ 5️⃣ 6️⃣
7️⃣ 8️⃣ 9️⃣

💡 يوجد لغمان مخفيان.
كل خانة آمنة تعطيك XP وفلوس وتكمل اللعبة.`);
  }

  if(command==='تفبيك_القنبلة'){
    G.SET(jid,'bomb',{wire:Math.floor(Math.random()*3)+1});
    return reply(`💣 تفكيك القنبلة

اختر السلك الصحيح:

1️⃣ 🔴 الأحمر
2️⃣ 🔵 الأزرق
3️⃣ 🟢 الأخضر

⏳ لديك محاولة واحدة!`);
  }

  if(command==='الهروب_من_السجن'){
    G.SET(jid,'prison',{step:1});
    return reply(`⛓️ الهروب من السجن

المرحلة 1/3

1️⃣ الباب
2️⃣ الحارس
3️⃣ النافذة
4️⃣ النفق
5️⃣ السلم

✏️ اختر رقمًا من 1 إلى 5`);
  }

  if(command==='سؤال_وخبرة'){
    const q=G.R(G.Q);
    G.SET(jid,'quiz',{answer:q[1],tries:0});
    return reply(`🧠 سؤال وخبرة

❓ ${q[0]}

✏️ اكتب الإجابة.`);
  }

  if(command==='سرقة_XP'){
    if(!target)return reply('❌ استخدم: .سرقة_XP @عضو');
    const tu=user(target);
    const amount=Math.min(500,Math.max(50,Math.floor((tu.xp||0)*.1)));
    if((tu.xp||0)<50)return reply('❌ هذا العضو لا يملك XP كافيًا.');
    if(Math.random()<.65){
      tu.xp=Math.max(0,(tu.xp||0)-amount);
      u.xp=(u.xp||0)+Math.floor(amount*.7);
      saveDB();
      return reply(`🥷💰 تمت السرقة!

⭐ أخذت ${Math.floor(amount*.7)} XP
⭐ خسر @${nameOf(target)} ${amount} XP`,[target]);
    }
    u.xp=Math.max(0,(u.xp||0)-50);
    saveDB();
    return reply('🚨 فشلت السرقة!\n⭐ -50 XP');
  }

  if(command==='شجرة_المهارات'){
    return reply(`🌳 شجرة المهارات

1️⃣ ⚔️ الهجوم — 500 XP
2️⃣ 🛡️ الدفاع — 750 XP
3️⃣ ⚡ السرعة — 1000 XP
4️⃣ 🔮 الطاقة — 1500 XP
5️⃣ 👑 الأسطورة — 2500 XP

⭐ XP الحالي: ${u.xp||0}
✏️ استخدم .شجرة_المهارات ثم اختر رقمًا`);
  }

  if(command==='ترتيب_الخبرة'){
    const db=require('./database.json');
    const list=Object.entries(db.users||{})
      .sort((a,b)=>(b[1].xp||0)-(a[1].xp||0)).slice(0,10);
    return reply('🏆 ترتيب الخبرة\n\n'+
      (list.length?list.map((x,i)=>`${i+1}. @${nameOf(x[0])} — ⭐ ${x[1].xp||0}`).join('\n'):'لا توجد بيانات'));
  }

  if(command==='عجلة_الحظ'){
    const prizes=[
      ['💰 +500$',500,0],
      ['💰 +1000$',1000,0],
      ['💎 +2 جواهر',300,20],
      ['⭐ +150 XP',0,150],
      ['🎁 +2500$',2500,0]
    ];
    const p=G.R(prizes);
    u.money=(u.money||0)+p[1];
    u.xp=(u.xp||0)+p[2];
    saveDB();
    return reply(`🎡 عجلة الحظ

🎯 النتيجة: ${p[0]}
⭐ XP: +${p[2]}
💰 المال: +$${p[1]}`);
  }

  if(command==='كلمة_السر'){
    const w=G.R(G.WORDS);
    G.SET(jid,'password',{w,tries:0});
    return reply('🔐 كلمة السر\n\n💡 كلمة من عالم الأنمي.\n\n✏️ لديك 5 محاولات.');
  }

  if(command==='من_هو_اللاعب'){
    const p=G.R(G.PLAYERS);
    G.SET(jid,'player',{answer:p[0].toLowerCase()});
    return reply(`⚽ من هو اللاعب؟

💡 النادي: ${p[1][0]}
💡 نادي آخر: ${p[1][1]}

✏️ اكتب اسم اللاعب.`);
  }

  if(command==='تخمين_الاعلام'){
    const f=G.R(G.FLAGS);
    G.SET(jid,'flag',{answer:f[1].toLowerCase()});
    return reply(`🌍 خمن العلم:

${f[0]}

✏️ اكتب اسم الدولة.`);
  }

  if(command==='تحدي_السرعة'){
    const n=Math.floor(Math.random()*90)+10;
    G.SET(jid,'speed',{answer:String(n)});
    return reply(`⚡ تحدي السرعة

🔢 الرقم هو:
👉 ${n}

✏️ اكتب الرقم بسرعة!`);
  }

  if(command==='صيد_الوحوش'){
    const monster=G.R(['🐉 التنين','👹 الأوني','🐺 الذئب','🧟 الزومبي']);
    G.SET(jid,'monster',{monster,hp:100,turn:0});
    return reply(`⚔️ صيد الوحوش

👾 الوحش: ${monster}
❤️ طاقته: 100

اختر هجومك:

1️⃣ ⚔️ ضربة عادية — ضرر 20
2️⃣ 🔥 ضربة نارية — ضرر 30
3️⃣ ⚡ ضربة برق — ضرر 40
4️⃣ 💥 ضربة قوية — ضرر 50
5️⃣ 🛡️ دفاع — يقلل ضرر الوحش

✏️ اختر 1-5`);
  }

  if(command==='قتال_البارون'){
    G.SET(jid,'baron',{hp:150,enemy:150,turn:0});
    return reply(`👑 قتال البارون

❤️ طاقتك: 150
👹 طاقة البارون: 150

اختر حركتك:

1️⃣ ⚔️ هجوم — 20 ضرر
2️⃣ 🔥 هجوم قوي — 30 ضرر
3️⃣ ⚡ هجوم سريع — 25 ضرر
4️⃣ 🛡️ دفاع
5️⃣ 💥 هجوم نهائي — 50 ضرر

✏️ اختر 1-5`);
  }

  if(command==='المتاهة'){
    G.SET(jid,'maze',{step:1,path:[]});
    return reply(`🌀 المتاهة

المرحلة 1/5

1️⃣ ⬆️ الطريق العلوي
2️⃣ ➡️ الطريق الأيمن
3️⃣ ⬇️ الطريق السفلي
4️⃣ ⬅️ الطريق الأيسر
5️⃣ 🚪 الباب الغامض

✏️ اختر 1-5`);
  }

  if(command==='احزر_الايموجي'){
    const e=G.R(G.EMO);
    G.SET(jid,'emoji',{answer:e[1].toLowerCase()});
    return reply(`🧩 احزر الإيموجي

${e[0]}

✏️ اكتب الكلمة.`);
  }

  if(command==='حبل_المشنقة'){
    const w=G.R(G.WORDS);
    G.SET(jid,'hang',{answer:w.toLowerCase(),letters:[],tries:0});
    return reply(`☠️ حبل المشنقة

الكلمة: ${w.replace(/./g,'_ ')}
❤️ لديك 5 أخطاء مسموحة.

✏️ اكتب حرفًا واحدًا.`);
  }

  if(command==='لو_خيروك'){
    const x=G.R([
      ['🌙 تعيش ليلاً للأبد','☀️ تعيش نهارًا للأبد'],
      ['💰 مليون دولار','⭐ شهرة عالمية'],
      ['🎮 ألعاب طوال اليوم','📺 أنمي طوال اليوم'],
      ['✈️ تسافر كل شهر','🏠 بيت أحلامك']
    ]);
    return reply(`🤔 لو خيروك

1️⃣ ${x[0]}
2️⃣ ${x[1]}

✏️ اكتب 1 أو 2`);
  }

  if(command==='مظلوم_او_ظالم'){
    const x=G.R([
      'شخص أخذ حقه بالقوة لأنه لم يجد من يساعده.',
      'شخص اتهم شخصًا بريئًا لحماية نفسه.',
      'شخص رفض مساعدة شخص لأنه أخطأ سابقًا.'
    ]);
    return reply(`⚖️ مظلوم أو ظالم؟

${x}

1️⃣ مظلوم
2️⃣ ظالم

✏️ اختر 1 أو 2`);
  }

  if(command==='اربع_على_سطر'){
    if(!target)return reply('❌ استخدم: .اربع_على_سطر @عضو');
    G.SET(jid,'connect4',{p1:sender,p2:target,turn:sender,b:Array(42).fill('')});
    return reply(`🎮 4 على سطر

❌ @${nameOf(sender)}
⭕ @${nameOf(target)}

1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣

👉 الدور: @${nameOf(sender)}
✏️ اختر العمود 1-7`,[sender,target]);
  }

  if(command==='السفينة_الحربية'){
    if(!target)return reply('❌ استخدم: .السفينة_الحربية @عضو');
    G.SET(jid,'ships',{
      p1:sender,p2:target,turn:sender,
      shots:{[sender]:[],[target]:[]},
      ships:{[sender]:G.R([1,2,3,4,5]),[target]:G.R([1,2,3,4,5])},
      hits:{[sender]:0,[target]:0}
    });
    return reply(`🚢⚔️ السفينة الحربية

❌ @${nameOf(sender)}
⭕ @${nameOf(target)}

كل لاعب لديه سفينة مخفية.

اختر خانة لضرب الخصم:
1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣
6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟

👉 الدور: @${nameOf(sender)}
✏️ اختر 1-10`,[sender,target]);
  }

  return false;
}

module.exports=gamesHandler;