const G=require('./games');

function handleGameReply({jid,sender,text,u,user,saveDB,reply,nameOf}){
  const key=t=>G.S(jid,t);
  const t=String(text||'').trim().toLowerCase();

  const reward=(usr,xp,gold)=>{
    usr.xp=(usr.xp||0)+xp;
    usr.money=(usr.money||0)+gold;
  };

  const finish=(msg,xp=100,gold=500)=>{
    reward(u,xp,gold);
    saveDB();
    return reply(msg+'\n\n⭐ +'+xp+' XP\n💰 +$'+gold);
  };

  let x;

  if((x=key('mine'))){
    const n=Number(t);
    if(!Number.isInteger(n)||n<1||n>9)return reply('❌ اختر رقمًا من 1 إلى 9.');
    if(x.used.includes(n))return reply('❌ هذه الخانة اخترتها من قبل.');
    x.used.push(n);

    if(x.bombs.includes(n)){
      G.DEL(jid,'mine');
      u.xp=Math.max(0,(u.xp||0)-100);
      u.money=Math.max(0,(u.money||0)-500);
      saveDB();
      return reply('💥💣 انفجر اللغم!\n\n💀 انتهت اللعبة.\n⭐ -100 XP\n💸 -$500');
    }

    x.safe++;
    reward(u,40,200);

    if(x.safe>=7){
      G.DEL(jid,'mine');
      reward(u,300,2000);
      saveDB();
      return reply('🏆💎 فزت في حقل الألغام!\n\n⭐ +340 XP\n💰 +$2200');
    }

    saveDB();
    return reply('✅💎 خانة آمنة!\n\n⭐ +40 XP\n💰 +$200\n🛡️ الخانات الآمنة: '+x.safe+'/7\n\nاختر خانة أخرى من 1 إلى 9.');
  }

  if((x=key('bomb'))){
    const n=Number(t);
    if(![1,2,3].includes(n))return reply('❌ اختر 1 أو 2 أو 3.');
    G.DEL(jid,'bomb');
    if(n===x.wire)return finish('🧯💚 نجحت في تفكيك القنبلة!',150,750);
    u.xp=Math.max(0,(u.xp||0)-50);
    u.money=Math.max(0,(u.money||0)-250);
    saveDB();
    return reply('💥 القنبلة انفجرت!\n⭐ -50 XP\n💸 -$250');
  }

  if((x=key('prison'))){
    const n=Number(t);
    if(![1,2,3,4,5].includes(n))return reply('❌ اختر رقمًا من 1 إلى 5.');
    const good=[3,5,2][x.step-1];
    if(n!==good){
      G.DEL(jid,'prison');
      u.xp=Math.max(0,(u.xp||0)-50);
      u.money=Math.max(0,(u.money||0)-200);
      saveDB();
      return reply('🚨💀 تم القبض عليك!\n⭐ -50 XP\n💸 -$200');
    }
    if(x.step>=3){
      G.DEL(jid,'prison');
      return finish('🏃‍♂️🔥 هربت من السجن!',200,1000);
    }
    x.step++;
    return reply('✅ الطريق صحيح!\n\n⛓️ المرحلة '+x.step+'/3\n\n1️⃣ الباب\n2️⃣ الحارس\n3️⃣ النافذة\n4️⃣ النفق\n5️⃣ السلم\n\n✏️ اختر 1-5');
  }

  if((x=key('quiz'))){
    if(t===String(x.answer).toLowerCase()){
      G.DEL(jid,'quiz');
      return finish('🧠🏆 إجابة صحيحة!',150,750);
    }
    x.tries++;
    if(x.tries>=3){
      G.DEL(jid,'quiz');
      return finish('❌ انتهت المحاولات.\nالإجابة: '+x.answer,10,50);
    }
    return reply('❌ إجابة خاطئة.\n❤️ المحاولات المتبقية: '+(3-x.tries));
  }

  if((x=key('password'))){
    if(t===x.w.toLowerCase()){
      G.DEL(jid,'password');
      return finish('🔐🏆 فتحت الخزنة!',200,1000);
    }
    x.tries++;
    if(x.tries>=5){
      G.DEL(jid,'password');
      u.xp=Math.max(0,(u.xp||0)-50);
      saveDB();
      return reply('🔒 فشلت! انتهت المحاولات.\n⭐ -50 XP\n🔑 كانت: '+x.w);
    }
    return reply('❌ كلمة سر خاطئة.\n❤️ المتبقي: '+(5-x.tries));
  }

  if((x=key('player'))){
    if(t===x.answer.toLowerCase()){
      G.DEL(jid,'player');
      return finish('⚽👑 إجابة صحيحة!',150,800);
    }
    return reply('❌ ليست الإجابة. حاول مرة أخرى.');
  }

  if((x=key('flag'))){
    if(t===x.answer.toLowerCase()){
      G.DEL(jid,'flag');
      return finish('🌍🏆 العلم صحيح!',120,600);
    }
    return reply('❌ خطأ، حاول مرة أخرى.');
  }

  if((x=key('speed'))){
    if(t===x.answer){
      G.DEL(jid,'speed');
      return finish('⚡🏆 إجابة صحيحة!',175,900);
    }
    return reply('❌ رقم خاطئ.');
  }

  if((x=key('monster'))){
    const n=Number(t);
    if(![1,2,3,4,5].includes(n))return reply('❌ اختر 1-5.');
    let dmg=[20,30,40,50,0][n-1];
    if(n===5)dmg=10;
    x.hp-=dmg;
    if(x.hp<=0){
      G.DEL(jid,'monster');
      return finish('👹💀 هزمت '+x.monster+'!',200,1200);
    }
    const enemy=Math.floor(Math.random()*25)+10;
    u.xp=(u.xp||0)+20;
    u.money=(u.money||0)+100;
    if(n!==5){
      u.xp=Math.max(0,(u.xp||0)-Math.floor(enemy/5));
    }
    saveDB();
    return reply('⚔️ ضربت الوحش!\n\n👾 '+x.monster+'\n❤️ المتبقي: '+x.hp+'\n💥 ضرر الوحش: '+enemy+'\n⭐ +20 XP\n💰 +$100\n\nاختر هجومًا 1-5.');
  }

  if((x=key('baron'))){
    const n=Number(t);
    if(![1,2,3,4,5].includes(n))return reply('❌ اختر 1-5.');
    const dmg=[20,30,25,0,50][n-1];
    x.enemy-=dmg;
    if(x.enemy<=0){
      G.DEL(jid,'baron');
      return finish('👑🏆 هزمت البارون!',300,2000);
    }
    const edmg=Math.floor(Math.random()*25)+10;
    if(n!==4)x.hp-=edmg;
    if(x.hp<=0){
      G.DEL(jid,'baron');
      u.xp=Math.max(0,(u.xp||0)-100);
      u.money=Math.max(0,(u.money||0)-500);
      saveDB();
      return reply('💀 خسرت أمام البارون!\n⭐ -100 XP\n💸 -$500');
    }
    saveDB();
    return reply('👑⚔️ الجولة التالية\n\n❤️ طاقتك: '+x.hp+'\n👹 طاقة البارون: '+x.enemy+'\n\n1️⃣ ⚔️ 20 ضرر\n2️⃣ 🔥 30 ضرر\n3️⃣ ⚡ 25 ضرر\n4️⃣ 🛡️ دفاع\n5️⃣ 💥 50 ضرر');
  }

  if((x=key('maze'))){
    const n=Number(t);
    if(![1,2,3,4,5].includes(n))return reply('❌ اختر 1-5.');
    const good=[2,4,1,5,3][x.step-1];
    if(n!==good){
      G.DEL(jid,'maze');
      u.xp=Math.max(0,(u.xp||0)-50);
      u.money=Math.max(0,(u.money||0)-200);
      saveDB();
      return reply('🌀💀 طريق مسدود!\n⭐ -50 XP\n💸 -$200');
    }
    if(x.step>=5){
      G.DEL(jid,'maze');
      return finish('🌀🏆 خرجت من المتاهة!',220,1200);
    }
    x.step++;
    return reply('✅ طريق صحيح!\n\n🌀 المرحلة '+x.step+'/5\n\n1️⃣ ⬆️\n2️⃣ ➡️\n3️⃣ ⬇️\n4️⃣ ⬅️\n5️⃣ 🚪');
  }

  if((x=key('emoji'))){
    if(t===x.answer.toLowerCase()){
      G.DEL(jid,'emoji');
      return finish('🧩🔥 حل صحيح!',120,600);
    }
    return reply('❌ خطأ، حاول مرة أخرى.');
  }

  if((x=key('hang'))){
    const ch=t[0];
    if(!ch)return reply('✏️ اكتب حرفًا.');
    if(x.letters.includes(ch))return reply('⚠️ هذا الحرف جُرّب من قبل.');
    x.letters.push(ch);
    if(x.answer.includes(ch)){
      if([...x.answer].every(c=>x.letters.includes(c))){
        G.DEL(jid,'hang');
        return finish('☠️🏆 حليت كلمة المشنقة!',200,1000);
      }
      return reply('✅ الحرف موجود!\n\n'+[...x.answer].map(c=>x.letters.includes(c)?c:'_').join(' '));
    }
    x.tries++;
    if(x.tries>=5){
      G.DEL(jid,'hang');
      u.xp=Math.max(0,(u.xp||0)-50);
      saveDB();
      return reply('☠️💀 انتهت المحاولات!\nالكلمة: '+x.answer+'\n⭐ -50 XP');
    }
    return reply('❌ الحرف غير موجود.\n❤️ المتبقي: '+(5-x.tries));
  }

  if((x=key('xo'))){
    if(sender!==x.p1&&sender!==x.p2)return false;
    if(sender!==x.turn)return reply('⏳ ليس دورك الآن.');
    const n=Number(t);
    if(![1,2,3,4,5,6,7,8,9].includes(n))return reply('❌ اختر خانة 1-9.');
    const i=n-1;
    if(x.b[i])return reply('❌ هذه الخانة مستخدمة.');
    x.b[i]=sender===x.p1?'❌':'⭕';

    const lines=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    const won=lines.some(a=>x.b[a[0]]&&x.b[a[0]]===x.b[a[1]]&&x.b[a[1]]===x.b[a[2]]);

    const show=i=>x.b[i]||(['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'][i]);
    const board=show(0)+' '+show(1)+' '+show(2)+'\n'+show(3)+' '+show(4)+' '+show(5)+'\n'+show(6)+' '+show(7)+' '+show(8);

    if(won){
      const winner=sender,loser=sender===x.p1?x.p2:x.p1;
      reward(user(winner),250,1500);
      const L=user(loser);
      L.xp=Math.max(0,(L.xp||0)-100);
      L.money=Math.max(0,(L.money||0)-500);
      G.DEL(jid,'xo');
      saveDB();
      return reply('🏆🎮 XO انتهت!\n\n'+board+'\n\n👑 الفائز: @'+nameOf(winner)+'\n⭐ +250 XP\n💰 +$1500\n\n💀 الخاسر: @'+nameOf(loser)+'\n⭐ -100 XP\n💸 -$500',[winner,loser]);
    }

    if(x.b.every(Boolean)){
      reward(user(x.p1),50,250);
      reward(user(x.p2),50,250);
      G.DEL(jid,'xo');
      saveDB();
      return reply('🤝🎮 تعادل!\n\n'+board+'\n\n⭐ كل لاعب +50 XP\n💰 كل لاعب +$250');
    }

    x.turn=sender===x.p1?x.p2:x.p1;
    saveDB();
    return reply('🎮 ❌⭕ XO\n\n'+board+'\n\n👉 الدور: @'+nameOf(x.turn)+'\n✏️ اختر رقمًا من 1 إلى 9',[x.turn]);
  }

  if((x=key('connect4'))){
    if(sender!==x.p1&&sender!==x.p2)return false;
    if(sender!==x.turn)return reply('⏳ ليس دورك.');
    const col=Number(t);
    if(![1,2,3,4,5,6,7].includes(col))return reply('❌ اختر عمودًا 1-7.');
    let pos=-1;
    for(let r=5;r>=0;r--){
      const i=r*7+(col-1);
      if(!x.b[i]){pos=i;break;}
    }
    if(pos<0)return reply('❌ العمود ممتلئ.');
    x.b[pos]=sender===x.p1?'❌':'⭕';

    const check=(r,c,dr,dc)=>{
      let count=0;
      while(r>=0&&r<6&&c>=0&&c<7&&x.b[r*7+c]===x.b[pos]){
        count++;r+=dr;c+=dc;
      }
      return count;
    };
    const r0=Math.floor(pos/7),c0=pos%7;
    const won=[[0,1],[1,0],[1,1],[1,-1]].some(([dr,dc])=>
      check(r0,c0,dr,dc)+check(r0-dr,c0-dc,-dr,-dc)-1>=4
    );

    const board=Array.from({length:6},(_,r)=>Array.from({length:7},(_,c)=>x.b[r*7+c]||'⚪').join(' ')).join('\n');

    if(won){
      reward(user(sender),300,1800);
      const loser=sender===x.p1?x.p2:x.p1;
      const L=user(loser);
      L.xp=Math.max(0,(L.xp||0)-100);
      L.money=Math.max(0,(L.money||0)-500);
      G.DEL(jid,'connect4');
      saveDB();
      return reply('🏆 4 على سطر!\n\n'+board+'\n\n👑 الفائز: @'+nameOf(sender)+'\n⭐ +300 XP\n💰 +$1800',[sender]);
    }

    if(x.b.every(Boolean)){
      G.DEL(jid,'connect4');
      return reply('🤝 4 على سطر انتهت بتعادل!\n\n'+board);
    }

    x.turn=sender===x.p1?x.p2:x.p1;
    saveDB();
    return reply('🎮 4 على سطر\n\n'+board+'\n\n1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣\n👉 الدور: @'+nameOf(x.turn),[x.turn]);
  }

  if((x=key('ships'))){
    if(sender!==x.p1&&sender!==x.p2)return false;
    if(sender!==x.turn)return reply('⏳ ليس دورك.');
    const n=Number(t);
    if(!Number.isInteger(n)||n<1||n>10)return reply('❌ اختر خانة 1-10.');
    if(x.shots[sender].includes(n))return reply('❌ ضربت هذه الخانة من قبل.');
    x.shots[sender].push(n);

    const enemy=sender===x.p1?x.p2:x.p1;
    if(n===x.ships[enemy]){
      x.hits[sender]++;
      if(x.hits[sender]>=1){
        G.DEL(jid,'ships');
        reward(user(sender),300,1800);
        const L=user(enemy);
        L.xp=Math.max(0,(L.xp||0)-100);
        L.money=Math.max(0,(L.money||0)-500);
        saveDB();
        return reply('🚢💥 إصابة مباشرة!\n\n🏆 @'+nameOf(sender)+' دمر سفينة الخصم!\n⭐ +300 XP\n💰 +$1800',[sender]);
      }
      return reply('🎯 إصابة! الدور مستمر.');
    }

    x.turn=enemy;
    saveDB();
    return reply('🌊 ماء! لم تصب السفينة.\n\n👉 الدور: @'+nameOf(enemy)+'\n✏️ اختر 1-10',[enemy]);
  }

  if((x=key('justice'))){
    if(!['1','2','مظلوم','ظالم'].includes(t))return reply('⚖️ اختر 1 أو 2.');
    G.DEL(jid,'justice');
    return finish('⚖️ تم تسجيل حكمك!',100,500);
  }

  return false;
}

module.exports=handleGameReply;