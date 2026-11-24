/* eslint-disable */
/* Procedural SVG artwork adapted from BLAST-handoff-v3/11-mission-control-launch-card/source/launch-kit.js.
 * Only the approved v3 editions are exposed. Assignment lives in editions.ts. */
function makeEditionArtwork(PATHS,backgroundForEdition){
  var C={punch:'#FF4C98',deep:'#F12D82',action:'#E88EAF',kicker:'#EFA1C9',paper:'#F8F5F7',canvas:'#0D1117',surface:'#141B23',raised:'#1B2530',line:'#28333F',muted:'#8E9CAB',pinkInk:'#260D1B',go:'#81CBA5',rec:'#FF5A4D',magenta:'#B03878',plum:'#281C35',navy:'#142532'};
  var FONT="Inter,-apple-system,'Helvetica Neue',Arial,sans-serif",W=1050,H=750,PX=64,PY=128,PS=456,RX=572;
  var ROLES=['Flight Director','CAPCOM','Booster Officer','Guidance Officer','Flight Dynamics','Telemetry','Payload Officer','Retro Officer','Recovery Lead','Ground Crew'];
  var BASE_THEME={name:'Standard black',bg:['#040405','#131316'],grid:'#1E1E23',gridO:.5,glow:C.punch,glow2:'#1E1E24',frame:['#1A1A1E','#3C3C44','#0C0C0E','#2A2A30','#15151A'],bezel:'#101013',bezelLine:C.punch,ink:C.paper,sub:C.muted,accent:C.kicker,ban:['#F34C96','#F12D82'],banInk:C.canvas,logo:[C.punch,C.paper],pill:'rgba(13,17,23,.7)',pillInk:C.paper};
  /* The Top-N editions. Each edition is its own card: background, art, colours, banner, frame and patch all change.
     theme overrides the Console look; art(pre,R) draws the edition's background motif inside the card. */
  var RAINBOW=['#FF6FB0','#FFB36E','#FFE98A','#8EF0C1','#6FC8FF','#B98CFF','#FF6FB0'];
  function rng(seed){return function(){seed=(seed*16807)%2147483647;return (seed-1)/2147483646;};}
  function stars(R,n,rmax,cols,op){var s='',i;cols=cols||['#fff'];for(i=0;i<n;i++){s+='<circle cx="'+r2(R()*W)+'" cy="'+r2(R()*H)+'" r="'+r2(.3+R()*(rmax||1.1))+'" fill="'+cols[i%cols.length]+'" opacity="'+r2((op||.2)+R()*.6)+'"/>';}return s;}
  function full(id){return '<rect width="'+W+'" height="'+H+'" fill="url(#'+id+')"/>';}
  /* ED builds a Top-N edition from a design on the card-ideas board (launch-concepts.js), same seed so it draws the same art. */
  function ED(max,name,seed,o){var t=o.theme;t.gridO=t.gridO||0;t.pill=t.pill||'rgba(0,0,0,.6)';t.spark=t.spark||'#fff';
    return {max:max,label:'TOP '+max,stage:name.toUpperCase(),name:name,finish:o.finish||'foil',seed:seed,frame:o.frame,num:o.num,accent:o.accent||t.accent,disc:o.disc||'#05040A',theme:t,art:o.art,chrome:o.chrome,flare:o.flare,holo:o.holo};}
  /* painted-nebula brush (also used by the ideas board): soft gradient puffs along flow lines, dust, filaments, stars. No bitmaps, no SVG filters. */
  function gs(R){return (R()+R()+R()+R()-2)/2;}
  function cr(p,t){var n=p.length-1,f=Math.min(t*n,n-1e-6),i=Math.floor(f),u2=f-i,a=p[Math.max(i-1,0)],b=p[i],c=p[i+1],d=p[Math.min(i+2,n)],uu=u2*u2,uuu=uu*u2;
    function k(j){return .5*((2*b[j])+(-a[j]+c[j])*u2+(2*a[j]-5*b[j]+4*c[j]-d[j])*uu+(-a[j]+3*b[j]-3*c[j]+d[j])*uuu);}return [k(0),k(1)];}
  function ell(cx,cy,rx,ry,rot,n,from,to){var p=[],i,a,c=Math.cos(rot),s=Math.sin(rot);from=from||0;to=to==null?Math.PI*2:to;for(i=0;i<=n;i++){a=from+(to-from)*i/n;var x=Math.cos(a)*rx,y=Math.sin(a)*ry;p.push([cx+x*c-y*s,cy+x*s+y*c]);}return p;}
  function paint(pre,R,bg,layers){
    var defs='',g={},k=0,out='<rect width="'+W+'" height="'+H+'" fill="'+bg+'"/>';
    function grad(c,hard){var key=c+(hard?'h':'');if(g[key])return g[key];var id=pre+'p'+(k++);
      defs+='<radialGradient id="'+id+'"><stop offset="0" stop-color="'+c+'"/><stop offset="'+(hard?.55:.3)+'" stop-color="'+c+'" stop-opacity="'+(hard?.8:.5)+'"/><stop offset="1" stop-color="'+c+'" stop-opacity="0"/></radialGradient>';return g[key]=id;}
    function puff(x,y,r,c,hard,op,L){var q=L.sq==null?.45:L.sq,ry=r*(q+R()*(1-q)),rot=L.ang!=null?L.ang+gs(R)*25:R()*180;
      return '<ellipse cx="'+r2(x)+'" cy="'+r2(y)+'" rx="'+r2(r)+'" ry="'+r2(ry)+'" transform="rotate('+Math.round(rot)+' '+r2(x)+' '+r2(y)+')" fill="url(#'+grad(c,hard)+')" opacity="'+r2(op)+'"/>';}
    layers.forEach(function(L){var i,c,pt,t,d,r;
      if(L.glow){out+='<circle cx="'+L.glow[0]+'" cy="'+L.glow[1]+'" r="'+L.glow[2]+'" fill="url(#'+grad(L.c)+')" opacity="'+L.o+'"/>';return;}
      if(L.stars){out+=stars(R,L.stars,L.r||1,L.c,L.o);return;}
      if(L.at){for(i=0;i<L.n;i++){var a=L.at,x0=a[0]+gs(R)*a[2],y0=a[1]+gs(R)*a[3];c=L.c[Math.floor(R()*L.c.length)];r=L.r[0]+Math.pow(R(),1.6)*(L.r[1]-L.r[0]);
        out+=puff(x0,y0,r,c,L.hard,L.o[0]+R()*(L.o[1]-L.o[0]),L);}return;}
      for(i=0;i<L.n;i++){t=R();pt=cr(L.p,t);var q=cr(L.p,Math.min(t+.01,1)),q0=cr(L.p,Math.max(t-.01,0)),tx=q[0]-q0[0],ty=q[1]-q0[1],tl=Math.hypot(tx,ty)||1,nx=-ty/tl,ny=tx/tl;
        d=L.edge?L.side*L.w*(L.edge+gs(R)*.1):L.side?Math.abs(gs(R))*L.w*L.side:gs(R)*L.w;
        var x=pt[0]+nx*d+gs(R)*L.w*.25,y=pt[1]+ny*d+gs(R)*L.w*.25;c=L.c[Math.floor(R()*L.c.length)];
        if(L.fil){var l=L.len*(.4+R()),bend=gs(R)*l*.5;out+='<path d="M'+r2(x-tx/tl*l/2)+' '+r2(y-ty/tl*l/2)+' Q'+r2(x+nx*bend)+' '+r2(y+ny*bend)+' '+r2(x+tx/tl*l/2)+' '+r2(y+ty/tl*l/2)+'" fill="none" stroke="'+c+'" stroke-width="'+r2(L.sw*(.4+R()))+'" stroke-linecap="round" opacity="'+r2(L.o[0]+R()*(L.o[1]-L.o[0]))+'"/>';continue;}
        r=L.r[0]+Math.pow(R(),1.6)*(L.r[1]-L.r[0]);
        out+=puff(x,y,r,c,L.hard,L.o[0]+R()*(L.o[1]-L.o[0]),L.along?{sq:.3,ang:Math.atan2(ty,tx)*180/Math.PI}:L);}
    });
    return '<defs>'+defs+'</defs>'+out;}
  function bright(R,pts,col){return pts.map(function(p){return '<circle cx="'+p[0]+'" cy="'+p[1]+'" r="'+(p[2]*3.2)+'" fill="'+(col||'#fff')+'" opacity=".12"/>'+sparkle(p[0],p[1],p[2]*9,'#fff',.95)+'<circle cx="'+p[0]+'" cy="'+p[1]+'" r="'+r2(p[2]*.9)+'" fill="#fff"/>';}).join('');}
  function scrim(pre){return '<defs><radialGradient id="'+pre+'scrim" cx="800" cy="330" r="360" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#000" stop-opacity=".34"/><stop offset=".7" stop-color="#000" stop-opacity=".14"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs><rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'scrim)"/>';}
  function dust(x,y,s,col){return {at:[x,y,s,s*.45],c:[col],n:Math.round(s*1.1),r:[s*.12,s*.45],o:[.25,.5]};}
  function holoCosmos(pre,R){var RBW=['#FF6FB0','#FFB36E','#FFE98A','#8EF0C1','#6FC8FF','#B98CFF'],L=[{glow:[300,380,720],c:'#3A1A80',o:.85},{glow:[900,300,500],c:'#1A2A80',o:.6}],i;
      for(i=0;i<6;i++){var o=i*46,p=[[-60,660-o],[260,580-o],[560,500-o*1.1],[820,320-o*.9],[1110,200-o*.7]];
        L.push({p:p,c:[RBW[i],RBW[(i+1)%6]],w:60,n:800,r:[18,80],o:[.08,.18],along:1});L.push({p:p,c:[RBW[i]],w:14,n:300,r:[6,22],o:[.12,.3],along:1});L.push({p:p,c:['#FFFFFF',RBW[i]],w:10,n:180,len:80,sw:1.8,o:[.15,.45],fil:1});}
      L.push(dust(420,720,120,'#0E0626'),dust(900,640,90,'#0E0626'));
      L.push({stars:640,r:1,c:['#fff','#FFE0F2','#CFF6FF','#FFF5C8'],o:.18});
      var s=paint(pre,R,'#08041A',L)+'<defs>'+linear(pre+'pr',RBW.concat(['#FF6FB0']),0,0,1,1)+'</defs>';
      [[-100,560,1300,44,.16],[-100,616,1300,10,.4],[200,-100,26,1200,.14]].forEach(function(b,j){s+='<rect x="'+b[0]+'" y="'+b[1]+'" width="'+b[2]+'" height="'+b[3]+'" fill="url(#'+pre+'pr)" opacity="'+b[4]+'" transform="rotate('+(j<2?-24:18)+' 525 375)"/>';});
      return s+bright(R,[[690,100,2.6],[1000,260,2.4],[590,630,2],[160,90,2.2]],'#FFE98A');}
  var TIERS={
    quasar:ED(25,'Quasar',3441,{frame:['#fff','#fff'],num:['#fff','#fff'],disc:'#05030C',finish:'cosmic',chrome:'holo',flare:[990,130],
      theme:{bg:['#05030C','#0B0620'],glow:'#000',glowA:0,glow2:'#000',glow2A:0,sub:'#D8D0F0',accent:'#E8FFF6',ban:['#fff','#fff'],bezel:'#05030C',pill:'rgba(5,3,12,.7)',strip:{fill:'rgba(5,3,12,.55)',stroke:'#E8FFF6',text:'#FFFFFF'}},
      art:function(pre,R){return holoCosmos(pre,R)+scrim(pre)+glint(40,700,.7,.8);}}),
    cosmic:{max:50, seed:17, label:'TOP 50', stage:'COSMIC', name:'Cosmic', finish:'cosmic', frame:['#2A1650','#FF4C98','#120A2E','#9FE3FF','#3A1E6B','#B98CFF','#0B0622'],num:['#FFFFFF','#E6D9FF','#9FE3FF'],accent:'#C9BCF2',disc:'#020108',
      theme:{bg:['#000000','#04030E'],glow:'#5B2CC9',glowA:.26,glow2:'#FF4C98',glow2A:.14,gridO:0,sub:'#8A83AE',accent:'#C9BCF2',ban:['#FF4C98','#8F4CFF','#3FB8FF'],banInk:'#020108',bezel:'#05040C',pill:'rgba(2,1,8,.8)',strip:{fill:'rgba(201,188,242,.06)',stroke:'#6E5FB0',text:'#DCD4FA'},spark:'#FFFFFF'},
      /* deep space: near-black, a faint band of the Milky Way, far galaxies, and a lot of stars */
      art:function(pre,R){
        var s='<defs>'+bloom(pre+'nb1',230,640,520,'#5B2CC9',.22)+bloom(pre+'nb2',900,150,440,'#FF4C98',.12)+bloom(pre+'nb3',1010,680,380,'#3FB8FF',.1)
          +'<linearGradient id="'+pre+'band" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".35" stop-color="#C9BCF2" stop-opacity=".07"/><stop offset=".5" stop-color="#fff" stop-opacity=".1"/><stop offset=".65" stop-color="#9FE3FF" stop-opacity=".06"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
          +'<radialGradient id="'+pre+'halo"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".3" stop-color="#CFE6FF" stop-opacity=".18"/><stop offset="1" stop-color="#CFE6FF" stop-opacity="0"/></radialGradient>'
          +'<radialGradient id="'+pre+'fg"><stop offset="0" stop-color="#FFF4E8" stop-opacity=".8"/><stop offset=".35" stop-color="#C9BCF2" stop-opacity=".25"/><stop offset="1" stop-color="#C9BCF2" stop-opacity="0"/></radialGradient></defs>';
        s+='<rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'nb1)"/><rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'nb2)"/><rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'nb3)"/>';
        /* the Milky Way: a soft diagonal band, thick with faint stars */
        s+='<g transform="rotate(-24 525 375)"><rect x="-300" y="300" width="1650" height="180" fill="url(#'+pre+'band)"/></g>';
        var i,tone=['#FFFFFF','#FFFFFF','#FFFFFF','#CFE6FF','#FFE6C8','#E6D9FF'];
        for(i=0;i<260;i++){var u=R()*1650-300,v=300+(R()+R()+R())/3*180,a=-24*Math.PI/180,x=525+(u-525)*Math.cos(a)-(v-375)*Math.sin(a),y=375+(u-525)*Math.sin(a)+(v-375)*Math.cos(a);
          s+='<circle cx="'+r2(x)+'" cy="'+r2(y)+'" r="'+r2(.3+R()*.7)+'" fill="'+tone[i%tone.length]+'" opacity="'+r2(.2+R()*.55)+'"/>';}
        /* the field: many faint stars, fewer mid ones */
        for(i=0;i<380;i++){s+='<circle cx="'+r2(R()*W)+'" cy="'+r2(R()*H)+'" r="'+r2(.3+R()*.8)+'" fill="'+tone[i%tone.length]+'" opacity="'+r2(.15+R()*.6)+'"/>';}
        for(i=0;i<46;i++){s+='<circle cx="'+r2(R()*W)+'" cy="'+r2(R()*H)+'" r="'+r2(1+R()*.9)+'" fill="'+tone[i%tone.length]+'" opacity="'+r2(.55+R()*.4)+'"/>';}
        /* far galaxies: small tilted smudges */
        [[610,86,26,8,-20],[1000,300,18,6,30],[560,700,22,7,12],[40,560,16,5,-40]].forEach(function(g){s+='<ellipse cx="'+g[0]+'" cy="'+g[1]+'" rx="'+g[2]+'" ry="'+g[3]+'" transform="rotate('+g[4]+' '+g[0]+' '+g[1]+')" fill="url(#'+pre+'fg)" opacity=".75"/>';});
        /* a few bright stars with halos and diffraction spikes */
        [[602,122,1],[1012,262,.8],[548,612,.9],[986,592,1.2],[836,700,.7],[36,690,.9],[700,40,.6]].forEach(function(b){var x=b[0],y=b[1],k=b[2];
          s+='<circle cx="'+x+'" cy="'+y+'" r="'+r2(14*k)+'" fill="url(#'+pre+'halo)"/><path d="M'+r2(x-18*k)+' '+y+'H'+r2(x+18*k)+'M'+x+' '+r2(y-18*k)+'V'+r2(y+18*k)+'" stroke="#fff" stroke-width="'+r2(.8*k)+'" opacity=".55"/><circle cx="'+x+'" cy="'+y+'" r="'+r2(1.8*k)+'" fill="#fff"/>';});
        return s;}},
    prism:{max:100, seed:7936, label:'TOP 100', stage:'PRISM', name:'Prism', finish:'holo', frame:RAINBOW,num:['#FFE98A','#8EF0C1','#6FC8FF'],accent:'#9FF0DA',disc:'#021016',
      theme:{bg:['#021016','#0E3044'],glow:'#8EF0C1',glowA:.3,glow2:'#6FC8FF',glow2A:.45,gridO:0,sub:'#8FB8C6',accent:'#9FF0DA',ban:['#FF8CC6','#FFD36E','#8EF0C1','#6FC8FF','#B98CFF'],banInk:'#021016',bezel:'#0A2230',pill:'rgba(2,16,22,.72)',strip:{fill:'rgba(159,227,255,.1)',stroke:'#9FE3FF',text:'#E4F6FF'},spark:'#FFFFFF'},
      art:function(pre,R){var s='',i;
        s+='<path d="M-60 250 L420 -40 L620 -40 L-60 420z" fill="url(#'+pre+'holo)" opacity=".16"/><path d="M180 790 L1110 170 L1110 330 L420 790z" fill="url(#'+pre+'holo)" opacity=".13"/><path d="M640 790 L1110 470 L1110 520 L720 790z" fill="url(#'+pre+'holo)" opacity=".3"/>';
        for(i=0;i<70;i++){s+='<circle cx="'+r2(R()*W)+'" cy="'+r2(R()*H)+'" r="'+r2(.6+R()*1.3)+'" fill="#fff" opacity="'+r2(.25+R()*.6)+'"/>';}
        return s;}},
    pearl:{max:150, seed:15855, label:'TOP 150', stage:'PEARL', name:'Pearl', finish:'pearl', frame:['#E9D8EC','#FFFFFF','#D4C4F2','#FDE1EC','#CDEFF0','#FFFFFF','#E9D8EC'],num:['#2A1A2E','#7A3D78'],accent:'#B03878',disc:'#1C1224',
      theme:{light:true,bg:['#FDF8FB','#E9E0F3'],glow:'#FFC9E1',glowA:.7,glow2:'#C9F2EC',glow2A:.7,grid:'#D9CCE6',gridO:.35,ink:'#2A1A2E',sub:'#7C6A86',accent:'#B03878',ban:['#2A1A2E','#4A2F52'],banInk:'#FFD6EA',bezel:'#2A1A2E',bezelLine:'#2A1A2E',logo:['#FF4C98','#2A1A2E'],pill:'rgba(42,26,46,.9)',pillInk:'#F8F5F7',strip:{fill:'rgba(42,26,46,.05)',stroke:'#B98CFF',text:'#2A1A2E'},spark:'#B98CFF'},
      art:function(pre,R){var s='<rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'pearl)" opacity=".45"/>',i;
        for(i=0;i<15;i++){var rad=84+i*44;s+='<circle cx="940" cy="440" r="'+rad+'" fill="none" stroke="#B9A6DA" stroke-width="1.3" opacity="'+r2(.5-i*.03)+'"/>';}
        return s;}},
    aurora:ED(200,'Aurora',512,{
    frame:['#0B3B2E','#8EF0C1','#FF8CC6','#D9FFE9','#1B5E4A'],num:['#E9FFF5','#8EF0C1'],disc:'#03110D',
    theme:{bg:['#010608','#041A22'],glow:'#8EF0C1',glowA:.18,glow2:'#FF8CC6',glow2A:.18,sub:'#8FB8AC',accent:'#A8F5D2',ban:['#8EF0C1','#FF8CC6'],banInk:'#021014',bezel:'#03110D',strip:{fill:'rgba(142,240,193,.08)',stroke:'#8EF0C1',text:'#E9FFF5'}},
    art:function(pre,R){var s='<defs>'+linear(pre+'au1',['#8EF0C1','#8EF0C1','rgba(142,240,193,0)'],0,1,0,0)+linear(pre+'au2',['#FF8CC6','#B98CFF','rgba(185,140,255,0)'],0,1,0,0)+'</defs>'+stars(R,160,.9,['#fff'],.15),i;
      for(i=0;i<7;i++){var y=520-i*30,x0=-40+i*20,amp=40+R()*50,p='M'+x0+' '+y;for(var x=x0;x<=1100;x+=110){p+=' Q'+(x+55)+' '+r2(y-amp*(R()*2-1))+' '+(x+110)+' '+r2(y+(R()-.5)*30);}
        s+='<path d="'+p+' V'+(y-360)+' H'+x0+'z" fill="url(#'+pre+(i%2?'au2':'au1')+')" opacity="'+r2(.1+R()*.12)+'"/>';}
      return s+'<ellipse cx="525" cy="1380" rx="1100" ry="760" fill="#020608"/><ellipse cx="525" cy="1380" rx="1100" ry="760" fill="none" stroke="#8EF0C1" stroke-width="3" opacity=".6"/>';}}),
    silver:{max:300, seed:23774, label:'TOP 300', stage:'SILVER', name:'Silver', finish:'foil', frame:['#6E7883','#F4F6F8','#9AA5B1','#FFFFFF','#59636E','#D8DEE4'],num:['#FFFFFF','#AEB8C2'],accent:'#E8EDF2',disc:'#0E1217',
      theme:{bg:['#08090B','#262B32'],glow:'#C9D1DB',glowA:.24,glow2:'#FFFFFF',glow2A:.1,gridO:0,sub:'#9AA5B1',accent:'#E8EDF2',ban:['#8E9CAB','#FFFFFF','#AEB8C2'],banInk:'#0D1117',bezel:'#121519',pill:'rgba(8,9,11,.72)',strip:{fill:'rgba(221,235,245,.08)',stroke:'#DDEBF5',text:'#FFFFFF'},spark:'#FFFFFF'},
      art:function(pre,R){var s='<g fill="none" stroke="#C9D1DB" stroke-width="1">',i;
        for(i=0;i<36;i++){s+='<ellipse cx="940" cy="440" rx="330" ry="128" transform="rotate('+(i*5)+' 940 440)" opacity=".13"/>';}
        for(i=0;i<24;i++){s+='<ellipse cx="940" cy="440" rx="180" ry="62" transform="rotate('+(i*7.5)+' 940 440)" opacity=".11"/>';}
        return s+'</g><rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'lines)" opacity=".03"/>';}},
    bronze:{max:500, seed:31693, label:'TOP 500', stage:'BRONZE', name:'Bronze', finish:'foil', frame:['#6B3A18','#F0B27A','#A0602F','#FFD9B8','#7A4520','#D08A55'],num:['#FFE3C8','#D08A55'],accent:'#F0B27A',disc:'#160C06',
      theme:{bg:['#140B06','#4A2C17'],glow:'#E08A4A',glowA:.28,glow2:'#FFD2A8',glow2A:.14,gridO:0,sub:'#B89478',accent:'#F0B27A',ban:['#8A4B22','#F0B27A','#B8693A'],banInk:'#1A0F08',bezel:'#1E120A',pill:'rgba(20,11,6,.7)',strip:{fill:'rgba(232,180,138,.1)',stroke:'#E8B48A',text:'#FFE3C8'},spark:'#FFD9B8'},
      art:function(pre,R){var s='<defs><radialGradient id="'+pre+'bplanet" cx=".35" cy=".2" r=".9"><stop offset="0" stop-color="#FFD2A8" stop-opacity=".38"/><stop offset=".6" stop-color="#A0602F" stop-opacity=".14"/><stop offset="1" stop-color="#140B06" stop-opacity="0"/></radialGradient></defs>';
        s+='<rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'brush)" opacity=".5"/><circle cx="1010" cy="1120" r="560" fill="url(#'+pre+'bplanet)"/><g fill="none" stroke="#E8B48A" stroke-width="1.5">';var o=[[430,120,-13],[330,86,7],[540,178,-3]];
        o.forEach(function(e){s+='<ellipse cx="820" cy="430" rx="'+e[0]+'" ry="'+e[1]+'" transform="rotate('+e[2]+' 820 430)" opacity=".24"/>';});s+='</g>';
        o.forEach(function(e,n){var a=[.5,2.4,4.1][n],x=820+e[0]*Math.cos(a),y=430+e[1]*Math.sin(a),k=e[2]*Math.PI/180,rx=820+(x-820)*Math.cos(k)-(y-430)*Math.sin(k),ry=430+(x-820)*Math.sin(k)+(y-430)*Math.cos(k);s+='<circle cx="'+r2(rx)+'" cy="'+r2(ry)+'" r="9" fill="#FFD9B8" opacity=".2"/><circle cx="'+r2(rx)+'" cy="'+r2(ry)+'" r="4" fill="#FFE3C8" opacity=".9"/>';});
        return s;}},
    lunar:{max:1000,seed:39612,label:'TOP 1000',stage:'LUNAR', name:'Lunar', finish:'matte', frame:['#5A6674','#2A333D','#8E9CAB','#1B2530','#4A5663'],num:['#FF8FC0','#FF4C98'],accent:'#C9D1DB',disc:'#10151B',
      theme:{bg:['#12161B','#262D34'],glow:'#FF4C98',glowA:.16,glow2:'#8E9CAB',glow2A:.22,gridO:0,sub:'#8E9CAB',accent:'#C9D1DB',ban:['#F34C96','#F12D82'],banInk:'#0D1117',bezel:'#1A1F25',pill:'rgba(13,17,23,.6)',spark:'#C9D1DB'},
      art:function(pre,R){var s='<g fill="none" stroke="#8E9CAB" stroke-width="1.2">',i;
        for(i=0;i<9;i++){var y=70+i*26;s+='<path d="M540 '+y+' C650 '+(y-30)+' 760 '+(y+34)+' 870 '+(y-6)+' S1000 '+(y-26)+' 1060 '+(y+12)+'" opacity="'+r2(.2-i*.015)+'"/>';}
        s+='</g><ellipse cx="525" cy="1330" rx="1000" ry="700" fill="#2C343C" stroke="#5A6674" stroke-width="2"/>';
        [[240,700,46,12],[520,676,30,8],[840,700,64,15],[980,668,22,6],[680,720,40,9],[120,676,20,5]].forEach(function(c){s+='<ellipse cx="'+c[0]+'" cy="'+c[1]+'" rx="'+c[2]+'" ry="'+c[3]+'" fill="#1F252B" stroke="#4A5663" stroke-width="1.5"/>';});
        return s;}}
  };
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function r2(n){return Math.round(n*100)/100;}
  function helmet(x,y,w,fill){var s=w/434;return '<path fill="'+fill+'" fill-rule="evenodd" transform="translate('+x+' '+y+') scale('+r2(s)+') translate(-409.33 -398)" d="'+PATHS.helmet+'"/>';}
  function word(x,y,w,fill){var s=w/451.34;return '<path fill="'+fill+'" fill-rule="evenodd" transform="translate('+x+' '+y+') scale('+r2(s)+') translate(-403.33 -715.33)" d="'+PATHS.word+'"/>';}
  function lockup(x,y,w,hc,wc){var k=w/1418;return '<g transform="translate('+x+' '+y+') scale('+r2(k)+')">'+helmet(0,0,434,hc)+word(517,18.5,900.4,wc)+'</g>';}
  function sparkle(x,y,w,fill,o){return '<path fill="'+fill+'" opacity="'+(o||1)+'" transform="translate('+r2(x-w/2)+' '+r2(y-w/2)+') scale('+r2(w/24)+')" d="M12 0c1 7 5 11 12 12-7 1-11 5-12 12-1-7-5-11-12-12 7-1 11-5 12-12z"/>';}
  function text(x,y,size,fill,str,o){o=o||{};return '<text x="'+x+'" y="'+y+'" font-family="'+FONT+'" font-size="'+size+'" font-weight="'+(o.w||500)+'" font-style="'+(o.i?'italic':'normal')+'" letter-spacing="'+(o.ls||'0')+'em" text-anchor="'+(o.a||'start')+'" fill="'+fill+'"'+(o.op?' opacity="'+o.op+'"':'')+(o.stroke?' stroke="'+o.stroke+'" stroke-width="'+(o.sw||2)+'" stroke-linejoin="round" paint-order="stroke"':'')+(o.len?' textLength="'+r2(o.len)+'" lengthAdjust="spacingAndGlyphs"':'')+'>'+esc(str)+'</text>';}
  function linear(id,stops,x1,y1,x2,y2){return '<linearGradient id="'+id+'" x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'">'+stops.map(function(c,i){return '<stop offset="'+r2(i/(stops.length-1))+'" stop-color="'+c+'"/>';}).join('')+'</linearGradient>';}
  function bloom(id,cx,cy,r,col,a){return '<radialGradient id="'+id+'" gradientUnits="userSpaceOnUse" cx="'+cx+'" cy="'+cy+'" r="'+r+'"><stop offset="0" stop-color="'+col+'" stop-opacity="'+a+'"/><stop offset=".5" stop-color="'+col+'" stop-opacity="'+r2(a*.45)+'"/><stop offset="1" stop-color="'+col+'" stop-opacity="0"/></radialGradient>';}
  function rr(x,y,w,h,r){return 'M'+(x+r)+' '+y+'h'+(w-2*r)+'a'+r+' '+r+' 0 0 1 '+r+' '+r+'v'+(h-2*r)+'a'+r+' '+r+' 0 0 1 -'+r+' '+r+'h-'+(w-2*r)+'a'+r+' '+r+' 0 0 1 -'+r+' -'+r+'v-'+(h-2*r)+'a'+r+' '+r+' 0 0 1 '+r+' -'+r+'z';}
  function handleOf(c){return '@'+String(c.name||'yourname').replace(/^@+/,'').slice(0,20);}
  /* 'RECRUITED BY  @handle' under the pre-registered line (crew.recruitedBy: who issued the code) */
  function recBy(x,y,c,V){var r=String(c.recruitedBy||'').replace(/^@+/,'').slice(0,20);if(!r)return '';return '<text x="'+x+'" y="'+y+'" font-family="'+FONT+'" font-size="13" font-weight="700" letter-spacing=".14em" fill="'+V.sub+'">RECRUITED BY  <tspan font-size="14" font-weight="800" letter-spacing=".01em" fill="'+V.ink+'">@'+esc(r)+'</tspan></text>';}
  function crewNo(c){var n=String(c.crewNo==null?'':c.crewNo).replace(/[^0-9]/g,'');return '#'+('0000'+(n||'1')).slice(-Math.max(4,n.length));}
  var PIXEL_GLYPHS={
    '#':['01010','01010','11111','01010','11111','01010','01010'],
    '0':['01110','10001','10011','10101','11001','10001','01110'],
    '1':['00100','01100','00100','00100','00100','00100','01110'],
    '2':['01110','10001','00001','00010','00100','01000','11111'],
    '3':['11110','00001','00001','01110','00001','00001','11110'],
    '4':['00010','00110','01010','10010','11111','00010','00010'],
    '5':['11111','10000','11110','00001','00001','10001','01110'],
    '6':['00110','01000','10000','11110','10001','10001','01110'],
    '7':['11111','00001','00010','00100','01000','01000','01000'],
    '8':['01110','10001','10001','01110','10001','10001','01110'],
    '9':['01110','10001','10001','01111','00001','00010','11100']
  };
  function pixelCrewNumber(value,x,y,size){var s='',step=(size||10),gap=step,chars=String(value).split('');
    chars.forEach(function(ch,n){var rows=PIXEL_GLYPHS[ch]||PIXEL_GLYPHS['0'];rows.forEach(function(row,ry){row.split('').forEach(function(on,rx){if(on==='1')s+='<rect x="'+(x+n*(step*5+gap)+rx*step)+'" y="'+(y+ry*step)+'" width="'+step+'" height="'+step+'"/>';});});});return s;}

  /* the edition patch: a round mission patch in the tier's material */
  /* the edition patch: a round mission patch in the edition's material. Top arc: edition name. Centre: TOP / number. Bottom arc: flight. */
  function patch(cx,cy,T,pre,ink){
    if(T.noBadge)return '';
    var R=66,r=54,at=41,ab=47,s='',pf=T.theme&&T.theme.light?'url(#'+pre+'tf)':'url(#'+pre+'tn)';
    s+='<circle cx="'+cx+'" cy="'+cy+'" r="'+(R+5)+'" fill="#000" opacity=".28"/>';
    s+='<circle cx="'+cx+'" cy="'+cy+'" r="'+R+'" fill="url(#'+pre+'tf)"/><circle cx="'+cx+'" cy="'+cy+'" r="'+R+'" fill="url(#'+pre+'tsh)"/>';
    s+='<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="'+T.disc+'"/>';
    if(T.badge){var b0=String(T.badge[0]||''),b1=String(T.badge[1]);return s+(b0?text(cx,cy-14,b0.length>6?11:13,ink,b0,{w:800,ls:.24,a:'middle'}):'')+text(cx,cy+(b0?27:15),b0?40:44,T.badgeFill||'url(#'+pre+'tn)',b1,{w:900,i:true,ls:-.02,a:'middle'});}
    s+='<path id="'+pre+'pt" d="M'+(cx-at)+' '+cy+'A'+at+' '+at+' 0 0 1 '+(cx+at)+' '+cy+'" fill="none"/><path id="'+pre+'pb" d="M'+(cx-ab)+' '+cy+'A'+ab+' '+ab+' 0 0 0 '+(cx+ab)+' '+cy+'" fill="none"/>';
    var st=String(T.stage),sfs=st.length>11?8.5:st.length>8?9.5:10.5;
    s+='<text font-family="'+FONT+'" font-size="'+sfs+'" font-weight="800" letter-spacing=".16em" fill="'+pf+'"><textPath href="#'+pre+'pt" startOffset="50%" text-anchor="middle">'+esc(st)+'</textPath></text>';
    s+='<text font-family="'+FONT+'" font-size="7.5" font-weight="700" letter-spacing=".2em" fill="'+ink+'" opacity=".6"><textPath href="#'+pre+'pb" startOffset="50%" text-anchor="middle">BLAST · FLIGHT 001</textPath></text>';
    var n=String(T.patchNum||T.max),top=String(T.patchTop||'TOP'),fs=n.length>3?29:36;
    s+=text(cx,cy-11,top.length>4?7.5:9.5,ink,top,{w:800,ls:.3,a:'middle',op:.75});
    s+=text(cx,cy+(n.length>3?19:22),fs,pf,n,{w:900,i:true,ls:-.03,a:'middle'});
    s+='<circle cx="'+(cx-at-4)+'" cy="'+(cy+2)+'" r="1.8" fill="'+ink+'" opacity=".55"/><circle cx="'+(cx+at+4)+'" cy="'+(cy+2)+'" r="1.8" fill="'+ink+'" opacity=".55"/>';
    return s;
  }


  /* chrome: banded metal gradients (light top, dark horizon at the middle, bright bottom) in several tints */
  var CHROME={
    silver:['#FFFFFF','#C9D3E0','#5C6B7E','#1E2633','#8FA0B4','#F4F8FF','#A9B6C6'],
    gold:['#FFF7D6','#F2C766','#8A5A12','#3A2204','#C9922E','#FFF1C2','#D9A441'],
    pink:['#FFFFFF','#FFC6E3','#B03878','#3E0A26','#FF4C98','#FFE6F2','#F28CBF'],
    mint:['#FFFFFF','#CFFBEA','#2E8C66','#0B3326','#8EF0C1','#EFFFF8','#A8F0D0'],
    fire:['#FFF8E0','#FFD08A','#C2410C','#3A0E03','#FF8A5C','#FFF0D6','#FFB067'],
    violet:['#FFFFFF','#E3D6FF','#6B3FC9','#1B0B40','#B98CFF','#F4EEFF','#C9B0FF'],
    sui:['#F4F6FA','#C9D3E0','#7586A5','#536179','#8FA0B4','#E8EDF5','#A9B6C6'],
    holo:['#FFFFFF','#FFB6DA','#8C5CFF','#101A40','#3FD0FF','#E8FFF6','#FFE98A'],
    rust:['#FFF1E8','#FFC2A0','#A8401C','#3A0F05','#E0683A','#FFE6D8','#F29A70'],
    amber:['#FFF8EC','#F6D2A0','#9A5E2A','#3A2210','#D89A5C','#FFF0DC','#E8B98A'],
    champagne:['#FFFDF4','#F1E4C0','#8F7A4A','#2E2614','#CDB27A','#FFF8E6','#E2CE9C'],
    aqua:['#FFFFFF','#D0FBF8','#3A9FA0','#0A3436','#7FE6E0','#EFFFFE','#A6F0EC'],
    azure:['#FFFFFF','#CCD8FF','#2F4FC4','#0A1446','#5B7BFF','#E8EEFF','#8FA6FF'],
    countdown:['#FFF3E6','#FFB27A','#B8420F','#2A0C02','#FF6A2A','#FFE2CC','#FF8C4A'],
    obsidian:['#C9CED8','#555B67','#1B1E24','#030304','#30343D','#8F96A3','#40454F']
  };
  /* metal (T.metal): the whole card is chrome. Light satin plate, dark engraved type, gunmetal role banner, chrome number, and the photo
     gradient-mapped through the chrome tint (an SVG filter: fine for exports; inside the pre-reg CRT glass bake it to a bitmap first). */
  function grainDef(id){var R=rng(7771),s='<pattern id="'+id+'" width="140" height="140" patternUnits="userSpaceOnUse">',i;for(i=0;i<5200;i++){s+='<rect x="'+r2(Math.floor(R()*280)/2)+'" y="'+r2(Math.floor(R()*280)/2)+'" width=".5" height=".5" fill="'+(R()<.5?'#000':'#fff')+'" opacity="'+r2(.3+R()*.6)+'"/>';}return s+'</pattern>';}
  function chromeTable(CH){return [CH[3],CH[2],CH[1],CH[0],CH[4],CH[2],CH[6],CH[5],CH[0]];}
  function metalDefs(pre,CH,dark){var t=chromeTable(CH),ch=function(i){return t.map(function(c){return r2(parseInt(c.slice(1+i*2,3+i*2),16)/255);}).join(' ');};
    return (dark?linear(pre+'plate',['#16181D','#060708','#23262D','#0C0D10','#040405','#1C1F25','#08090B','#25282F','#060708'],0,0,1,.8):linear(pre+'plate',[CH[4],CH[1],CH[0],CH[6],CH[4],CH[1],CH[5],CH[0],CH[6]],0,0,1,.8))
      +'<linearGradient id="'+pre+'hz" x1="0" y1="0" x2="0" y2="1"><stop offset=".5" stop-color="'+CH[2]+'" stop-opacity="0"/><stop offset=".6" stop-color="'+CH[2]+'" stop-opacity=".3"/><stop offset=".63" stop-color="'+CH[3]+'" stop-opacity=".22"/><stop offset=".645" stop-color="#fff" stop-opacity=".55"/><stop offset=".7" stop-color="#fff" stop-opacity="0"/><stop offset=".9" stop-color="'+CH[2]+'" stop-opacity="0"/><stop offset="1" stop-color="'+CH[2]+'" stop-opacity=".25"/></linearGradient>'+linear(pre+'gm',['#3A3F48','#15171C','#0B0C10','#2A2E36'],0,0,0,1)
      +'<filter id="'+pre+'chr" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncR type="table" tableValues="'+ch(0)+'"/><feFuncG type="table" tableValues="'+ch(1)+'"/><feFuncB type="table" tableValues="'+ch(2)+'"/></feComponentTransfer></filter>'
      +'<pattern id="'+pre+'brushed" width="400" height="2" patternUnits="userSpaceOnUse"><rect width="400" height=".6" fill="#fff" opacity=".45"/><rect y="1.2" width="400" height=".4" fill="#000" opacity=".1"/></pattern>'
      +'<linearGradient id="'+pre+'sweep" x1="0" y1="0" x2="1" y2="1"><stop offset=".14" stop-color="#fff" stop-opacity="0"/><stop offset=".22" stop-color="#fff" stop-opacity=".85"/><stop offset=".235" stop-color="#fff" stop-opacity=".2"/><stop offset=".26" stop-color="#fff" stop-opacity=".6"/><stop offset=".32" stop-color="#fff" stop-opacity="0"/><stop offset=".44" stop-color="'+CH[2]+'" stop-opacity="0"/><stop offset=".5" stop-color="'+CH[2]+'" stop-opacity=".28"/><stop offset=".56" stop-color="'+CH[2]+'" stop-opacity="0"/><stop offset=".7" stop-color="#fff" stop-opacity="0"/><stop offset=".76" stop-color="#fff" stop-opacity=".7"/><stop offset=".8" stop-color="#fff" stop-opacity="0"/><stop offset=".88" stop-color="'+CH[4]+'" stop-opacity="0"/><stop offset=".95" stop-color="'+CH[4]+'" stop-opacity=".4"/></linearGradient>';}
  var COFF=[0,.34,.48,.5,.6,.84,1];
  function cgrad(id,c,x1,y1,x2,y2,spread){return '<linearGradient id="'+id+'" x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'"'+(spread?' spreadMethod="'+spread+'"':'')+'>'+c.map(function(col,i){return '<stop offset="'+COFF[i]+'" stop-color="'+col+'"/>';}).join('')+'</linearGradient>';}
  function glint(x,y,k,o){k=k||1;return '<g opacity="'+(o||1)+'"><path d="M'+r2(x-30*k)+' '+y+'H'+r2(x+30*k)+'M'+x+' '+r2(y-30*k)+'V'+r2(y+30*k)+'" stroke="#fff" stroke-width="'+r2(.9*k)+'" opacity=".75"/>'+sparkle(x,y,15*k,'#fff',1)+'<circle cx="'+x+'" cy="'+y+'" r="'+r2(2.2*k)+'" fill="#fff"/></g>';}
  function flare(x,y,col,pre){var s='<ellipse cx="'+x+'" cy="'+y+'" rx="300" ry="3.5" fill="url(#'+pre+'fl)"/><ellipse cx="'+x+'" cy="'+y+'" rx="140" ry="1.4" fill="#fff" opacity=".85"/><circle cx="'+x+'" cy="'+y+'" r="34" fill="url(#'+pre+'flc)"/>',dx=525-x,dy=375-y;
    [[.3,12,.22],[.55,28,.1],[.78,8,.3],[1.1,46,.07],[1.3,16,.14]].forEach(function(g){s+='<circle cx="'+r2(x+dx*g[0])+'" cy="'+r2(y+dy*g[0])+'" r="'+g[1]+'" fill="'+col+'" opacity="'+g[2]+'"/>';});return s;}

  /* Secret rares tied to one crew number. #0503 is Sui's mainnet birthday (3 May 2023).
     In production the server says which numbers are special; this map only holds the designs. */
  var SPECIALS={
    manifest:{key:'manifest',one:true,metal:true,stamp:false,noBadge:true,grain:.22,label:'1 OF 1',stage:'MANIFEST',name:'Manifest',shareLine:'1 OF 1  ·  MANIFEST FREEDOM 69',line2:'MANIFEST FREEDOM 69',finish:'metal',chrome:'gold',shareAccent:'#F2C766',recruitedBy:'blastdotfun',
      frame:['#fff','#fff'],num:['#fff','#fff'],accent:'#8A5A12',disc:'#0B0C10',
      theme:{bg:['#fff','#fff'],glow:'#000',glowA:0,glow2:'#000',glow2A:0,gridO:0,ban:['#fff','#fff'],bezel:'#0B0C10',strip:{fill:'rgba(14,16,22,.06)',stroke:'#0E1016',text:'#0E1016'},spark:'#fff'},
      art:function(){return '';}},
    countdown:{key:'countdown',one:true,metal:'dark',metalTheme:{sub:'#C8B4A8',accent:'#FF6A2A',logo:['#FF6A2A','#F4F6FA']},stamp:false,noBadge:true,grain:.2,label:'1 OF 1',stage:'COUNTDOWN',name:'Countdown',shareLine:'1 OF 1  ·  COUNTDOWN  ·  1 · 2 · 3',line2:'3  ·  2  ·  1  ·  BLASTOFF',finish:'metal',chrome:'countdown',shareAccent:'#FF8C4A',shareMetalButton:true,recruitedBy:'blastdotfun',litFrom:2,ban:['#FFD2A8','#FF8C4A','#FF5A1F','#FF8C4A'],
      frame:['#fff','#fff'],num:['#fff','#fff'],accent:'#FF6A2A',disc:'#050303',
      theme:{bg:['#0A0706','#1A1512'],glow:'#000',glowA:0,glow2:'#000',glow2A:0,gridO:0,ban:['#fff','#fff'],bezel:'#050303',strip:{fill:'rgba(255,255,255,.04)',stroke:'#FF8C4A',text:'#FFE2CC'},spark:'#fff'},
      art:function(){return '';}},
    '8-bit':{key:'8-bit',one:true,stamp:false,noBadge:true,pixelNumber:true,label:'1 OF 1',stage:'8-BIT',name:'8-Bit',shareLine:'1 OF 1  ·  8-BIT  ·  PRESS START',line2:'PRESS START  ·  2⁸ = 256',finish:'pixel',shareAccent:'#5CE1FF',recruitedBy:'blastdotfun',
      frame:['#FF4C98','#FFFFFF','#FF4C98','#7B3CFF','#5CE1FF','#FF4C98'],num:['#FFFFFF','#FF8CC6'],accent:'#5CE1FF',disc:'#06061C',
      theme:{bg:['#06061C','#141044'],glow:'#7B3CFF',glowA:.22,glow2:'#FF4C98',glow2A:.14,gridO:0,ink:'#F8F5F7',sub:'#9C9CD0',accent:'#5CE1FF',ban:['#FF4C98','#FF4C98'],banInk:'#07070D',bezel:'#06061C',pill:'rgba(6,6,28,.85)',pillInk:'#F8F5F7',logo:['#FF4C98','#F8F5F7'],strip:{fill:'rgba(92,225,255,.08)',stroke:'#5CE1FF',text:'#E8FBFF'},spark:'#FFE98A'},
      art:function(){return '';}},
    sui:{key:'sui',one:true,metal:'dark',metalTheme:{sub:'#C9D3E0',accent:'#A9B6C6',logo:['#A9B6C6','#F4F6FA']},stamp:false,noBadge:true,grain:.22,label:'1 OF 1',stage:'SUI',name:'Sui',shareLine:'1 OF 1  ·  SUI MAINNET  ·  05.03.23',line2:'SUI MAINNET  ·  MAY 03, 2023',finish:'metal',chrome:'sui',
      frame:['#7586A5','#536179'],num:['#F4F6FA','#A9B6C6'],accent:'#A9B6C6',disc:'#191C26',ban:['#D8DFEA','#C9D3E0','#7586A5','#536179'],
      theme:{bg:['#191C26','#1D212C'],glow:'#000',glowA:0,glow2:'#000',glow2A:0,gridO:0,ban:['#191C26','#1D212C'],bezel:'#0B0C10',strip:{fill:'rgba(255,255,255,.04)',stroke:'#7586A5',text:'#F4F6FA'},spark:'#fff'},
      art:function(){return '';}},
    'blast-launch-day':{key:'blast',one:true,metal:'dark',stamp:false,noBadge:true,grain:.2,label:'1 OF 1',stage:'BLAST',name:'Blast launch day',line2:'BLAST LAUNCH  ·  JUL 27, 2025',shareLine:'1 OF 1  ·  BLAST LAUNCH  ·  07.27.25',finish:'metal',chrome:'obsidian',
      frame:['#fff','#fff'],num:['#fff','#fff'],accent:'#FF4C98',disc:'#050608',
      theme:{bg:['#0B0C10','#15171C'],glow:'#000',glowA:0,glow2:'#000',glow2A:0,gridO:0,ban:['#fff','#fff'],bezel:'#050608',strip:{fill:'rgba(255,255,255,.04)',stroke:'#6B7280',text:'#E6E8EE'},spark:'#fff'},
      /* an oversized BLAST helmet in black chrome pressed into the plate, with a pink edge; pink helmets as small accents */
      art:function(pre,R){var hw=760,hx=560,hy=150,k=hw/434,sw=function(px){return r2(px/k);},hp=function(fill,extra,dx,dy){return helmet(hx+(dx||0),hy+(dy||0),hw,fill).replace('<path ','<path '+(extra||''));};
        return '<defs>'+cgrad(pre+'bh',CHROME.obsidian,0,0,.35,1)+'</defs>'
          +hp('url(#'+pre+'bh)','opacity=".5" ')
          +hp('none','stroke="#FF4C98" stroke-width="'+sw(2.2)+'" opacity=".75" ',3,3)
          +hp('none','stroke="#FFFFFF" stroke-width="'+sw(1.2)+'" opacity=".35" ',-1.5,-1.5)
          +helmet(996,612,26,'#FF4C98');}}
  };
  function cardSVG(crew,edition,scale,pre,backgroundOnly){
    pre=pre||'lc-';var V=BASE_THEME,hot=false,i,s='';
    var SP=SPECIALS[edition],T=SP||TIERS[edition],frameStops=T?T.frame:V.frame;
    if(T&&T.recruitedBy&&!crew.recruitedBy)crew=Object.assign({},crew,{recruitedBy:T.recruitedBy});
    if(T)V=Object.assign({},BASE_THEME,{grid:'#28333F'},T.theme);
    var R=rng(SP?(T.key==='manifest'?69:T.key==='countdown'?123:T.key==='8-bit'?256:T.key==='blast'?727:503):T?T.seed:17),ST=V.strip||{fill:'rgba(129,203,165,.12)',stroke:C.go,text:'#D9FFE9'};
    var CH=T&&T.chrome?CHROME[T.chrome]:null,ONE=!!(T&&T.one),M=!!(T&&T.metal&&CH),MD=M&&T.metal==='dark',AV=M&&crew.avatarChrome?crew.avatarChrome:crew.avatar,AF=M&&!crew.avatarChrome?' filter="url(#'+pre+'chr)"':'';if(CH)V.banInk='#0A0A12';
    if(M)V=Object.assign({},V,MD?{light:false,ink:'#F4F6FA',sub:'#AEB5C1',accent:'#FF4C98',logo:['#FF4C98','#F4F6FA'],pill:'rgba(0,0,0,.55)',pillInk:'#F4F6FA'}:{light:true,ink:'#0E1016',sub:'#0E1016',accent:'#0E1016',logo:['#0E1016','#0E1016'],pill:'rgba(12,14,20,.88)',pillInk:'#F4F6FA'},T.metalTheme||{});
    var defs=(CH?cgrad(pre+'frame',CH,0,0,.3,.42,'reflect'):linear(pre+'frame',frameStops,0,0,1,1))+linear(pre+'bg',V.bg,0,0,1,.5)+(MD?linear(pre+'ban',T.ban||['#FF8CC6','#FF4C98','#F12D82','#FF4C98'],0,0,0,1):CH?linear(pre+'ban',[CH[0],CH[1],CH[5],CH[6],CH[1],CH[0]],0,0,0,1):linear(pre+'ban',V.ban,0,0,1,0))
      +bloom(pre+'gl',60,740,700,V.glow,T?V.glowA:(hot?.35:.3))+bloom(pre+'gl2',1000,20,620,T?V.glow2:(hot?C.action:(V.glow2||C.raised)),T?V.glow2A:(hot?.8:.85))
      +'<pattern id="'+pre+'grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="'+V.grid+'" stroke-width="1"/></pattern>'
      +'<pattern id="'+pre+'scan" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="2" fill="#000" opacity=".16"/></pattern>'
      +'<radialGradient id="'+pre+'vig" cx=".5" cy=".5" r=".72"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></radialGradient>'
      +'<linearGradient id="'+pre+'sheen" x1="0" y1="0" x2="1" y2="1"><stop offset=".30" stop-color="#fff" stop-opacity="0"/><stop offset=".44" stop-color="#fff" stop-opacity=".8"/><stop offset=".52" stop-color="#fff" stop-opacity=".12"/><stop offset=".60" stop-color="#fff" stop-opacity=".55"/><stop offset=".72" stop-color="#fff" stop-opacity="0"/></linearGradient>'
      +'<clipPath id="'+pre+'clip"><rect x="14" y="14" width="'+(W-28)+'" height="'+(H-28)+'" rx="26"/></clipPath><clipPath id="'+pre+'scr"><rect x="'+PX+'" y="'+PY+'" width="'+PS+'" height="'+PS+'" rx="34"/></clipPath><clipPath id="'+pre+'av"><circle cx="604" cy="300" r="27"/></clipPath>';
    if(T){defs+=(CH?cgrad(pre+'tf',CH,0,0,.3,.42,'reflect')+cgrad(pre+'tn',CH,0,0,0,1)+'<linearGradient id="'+pre+'fl"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><radialGradient id="'+pre+'flc"><stop offset="0" stop-color="#fff"/><stop offset=".25" stop-color="#fff" stop-opacity=".6"/><stop offset="1" stop-color="'+CH[4]+'" stop-opacity="0"/></radialGradient>':linear(pre+'tf',T.frame,0,0,1,1)+linear(pre+'tn',T.num,0,0,0,1))
      +'<linearGradient id="'+pre+'tsh" x1="0" y1="0" x2="1" y2="1"><stop offset=".25" stop-color="#fff" stop-opacity="0"/><stop offset=".45" stop-color="#fff" stop-opacity=".55"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient>'
      +linear(pre+'holo',RAINBOW,0,0,1,1)+linear(pre+'pearl',['#FFD6EA','#E4D6FF','#CFF4EE','#FFE8D6','#FFD6EA'],0,0,1,1)
      +bloom(pre+'ember',940,440,520,'#FF6A4A',.62)+bloom(pre+'heat',880,640,700,'#FF3D1F',.5)+'<radialGradient id="'+pre+'planet" cx=".35" cy=".2" r=".9"><stop offset="0" stop-color="#DDEBF5" stop-opacity=".35"/><stop offset=".6" stop-color="#8E9CAB" stop-opacity=".12"/><stop offset="1" stop-color="#0D1117" stop-opacity="0"/></radialGradient>'+'<pattern id="'+pre+'brush" width="6" height="3" patternUnits="userSpaceOnUse"><rect width="6" height="1" fill="#fff" opacity=".05"/></pattern>'
      +'<pattern id="'+pre+'lines" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="10" height="1.2" fill="#fff"/></pattern>'+(M?metalDefs(pre,CH,MD):'')+(T.grain?grainDef(pre+'grain'):'');}

    if(backgroundForEdition&&!backgroundOnly){
      s='<image href="'+backgroundForEdition(edition)+'" width="'+W+'" height="'+H+'"/>';
    }else{
    /* body */
    s+='<rect width="'+W+'" height="'+H+'" rx="38" fill="url(#'+pre+'frame)"/>'+(T&&T.finish==='cosmic'?'<rect x="3" y="3" width="'+(W-6)+'" height="'+(H-6)+'" rx="35" fill="none" stroke="#FFF3C4" stroke-width="2" opacity=".6"/>':'')+'<g clip-path="url(#'+pre+'clip)"><rect width="'+W+'" height="'+H+'" fill="url(#'+pre+(M?'plate':'bg')+')"/>'+(M?'<rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'brushed)"'+(MD?' opacity=".3"':'')+'/><rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'hz)"'+(MD?' opacity=".5"':'')+'/><rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'sweep)"'+(MD?' opacity=".4"':'')+'/>':'')+'<rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'grid)" opacity="'+V.gridO+'"/><rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'gl2)"/><rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'gl)"/>'+(T?T.art(pre,R):'')+(T&&(T.holo||ONE)?'<rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'holo)" opacity="'+(M?.07:ONE?.16:.12)+'"/><rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'lines)" opacity=".05"/>':'')+(CH&&T.flare?flare(T.flare[0],T.flare[1],CH[4],pre):'');
    /* edition finish, baked in so exports carry it (the pages add a moving light on top) */
    if(T){
      if(T.finish==='gloss')s+='<rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'sheen)" opacity=".10"/>';
      if(T.finish==='foil')s+='<rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'lines)" opacity=".035"/><rect width="'+W+'" height="'+H+'" fill="url(#'+pre+'sheen)" opacity=".08"/>';
      
      
            if(T.finish==='holo'||T.finish==='pearl'){[[612,108,14],[1000,122,10],[860,610,12],[548,640,9],[1008,560,16],[700,92,8]].forEach(function(p){s+=sparkle(p[0],p[1],p[2],V.spark||'#fff',.75);});}
    }
    s+='</g>';
    s+='<path fill-rule="evenodd" fill="url(#'+pre+'sheen)" opacity="'+(T?(T.finish==='matte'?.7:1):.35)+'" d="'+rr(0,0,W,H,38)+rr(14,14,W-28,H-28,26)+'"/><rect x="26" y="26" width="'+(W-52)+'" height="'+(H-52)+'" rx="18" fill="none" stroke="'+V.ink+'" stroke-width="1.5" opacity=".2"/>';
    if(T&&T.grain)s+='<rect width="'+W+'" height="'+H+'" rx="38" fill="url(#'+pre+'grain)" opacity="'+T.grain+'"/>';
    if(CH){s+='<rect x="1.5" y="1.5" width="'+(W-3)+'" height="'+(H-3)+'" rx="37" fill="none" stroke="#000" stroke-opacity=".55" stroke-width="2"/><rect x="9" y="9" width="'+(W-18)+'" height="'+(H-18)+'" rx="30" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="1.2"/><rect x="14" y="14" width="'+(W-28)+'" height="'+(H-28)+'" rx="26" fill="none" stroke="#000" stroke-opacity=".5" stroke-width="2.2"/>';}

    }
    if(backgroundOnly)return '<svg xmlns="http://www.w3.org/2000/svg" width="2100" height="1500" viewBox="0 0 '+W+' '+H+'"><defs>'+defs+'</defs>'+s+'</svg>';

    /* header */
    s+=lockup(52,50,192,V.logo[0],V.logo[1])+'<rect x="798" y="46" width="206" height="44" rx="22" fill="'+V.pill+'"/><circle cx="822" cy="68" r="6" fill="'+C.go+'"/><circle cx="822" cy="68" r="11" fill="'+C.go+'" opacity=".25"/>'+text(840,73,13,V.pillInk,'MISSION CONTROL',{w:700,ls:.16});

    /* the monitor (left) */
    s+='<rect x="'+(PX-16)+'" y="'+(PY-16)+'" width="'+(PS+32)+'" height="'+(PS+32)+'" rx="46" fill="'+(M?'url(#'+pre+'tf)':V.bezel)+'" stroke="'+(T?'url(#'+pre+'tf)':V.bezelLine)+'" stroke-width="3"/>';
    if(!M)[[PX-2,PY-2],[PX+PS+2,PY-2],[PX-2,PY+PS+2],[PX+PS+2,PY+PS+2]].forEach(function(p){s+='<circle cx="'+p[0]+'" cy="'+p[1]+'" r="4" fill="'+C.muted+'" opacity=".7"/>';});
    var scr='<rect x="'+PX+'" y="'+PY+'" width="'+PS+'" height="'+PS+'" fill="#0A0F16"/>';
    if(crew.avatar){scr+='<image href="'+AV+'" x="'+PX+'" y="'+PY+'" width="'+PS+'" height="'+PS+'" preserveAspectRatio="xMidYMid slice"'+AF+'/>'+(M?'<rect x="'+PX+'" y="'+PY+'" width="'+PS+'" height="'+PS+'" fill="url(#'+pre+'tsh)" opacity=".6"/>':'');}
    else{scr+=helmet(PX+120,PY+130,216,C.punch)+text(PX+PS/2,PY+PS-92,14,C.muted,'DROP A PROFILE PICTURE',{w:700,ls:.18,a:'middle'});}
    scr+='<rect x="'+PX+'" y="'+PY+'" width="'+PS+'" height="'+PS+'" fill="url(#'+pre+'scan)"/><rect x="'+PX+'" y="'+PY+'" width="'+PS+'" height="'+PS+'" fill="url(#'+pre+'vig)"/>';
    var b=20,L=32,x0=PX+b,y0=PY+b,x1=PX+PS-b,y1=PY+PS-b;
    scr+='<g fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".9"><path d="M'+x0+' '+(y0+L)+'V'+y0+'H'+(x0+L)+'"/><path d="M'+(x1-L)+' '+y0+'H'+x1+'V'+(y0+L)+'"/><path d="M'+x0+' '+(y1-L)+'V'+y1+'H'+(x0+L)+'"/><path d="M'+(x1-L)+' '+y1+'H'+x1+'V'+(y1-L)+'"/></g>';
    scr+=text(x0+14,y0+22,12,'#fff','CAM 01  ·  CREW',{w:700,ls:.16})+'<circle cx="'+(x1-66)+'" cy="'+(y0+18)+'" r="5.5" fill="'+C.rec+'"/>'+text(x1-14,y0+22,12,'#fff','REC',{w:700,ls:.16,a:'end'})
      +text(x0+14,y1-12,17,'#fff','T−00:10:00',{w:800,ls:.04})+text(x1-14,y1-12,12,'#fff','SIGNAL 100%',{w:700,ls:.14,a:'end'});
    s+='<g clip-path="url(#'+pre+'scr)">'+scr+'</g>';
    var st=String(crew.stamp==null?'GO FOR LAUNCH':crew.stamp).toUpperCase().slice(0,18);
    if(st){var sw=Math.max(140,st.length*16+40);s+='<g transform="rotate(-8 '+(PX+PS-140)+' '+(PY+PS-64)+')"><rect x="'+r2(PX+PS-18-sw)+'" y="'+(PY+PS-104)+'" width="'+r2(sw)+'" height="54" rx="9" fill="'+(M?'url(#'+pre+'ban)':'rgba(10,15,22,.72)')+'" stroke="'+(M?'#0E1016':C.go)+'" stroke-width="4"/>'+text(r2(PX+PS-18-sw/2),PY+PS-68,22,M?'#0E1016':C.go,st,{w:900,ls:.08,a:'middle'})+'</g>';}

    /* right column: station, role banner (runs out of the right border), owner, crew number */
    s+=text(RX,150,15,V.accent,'RECRUITED FOR  '+String(crew.flight||'FLIGHT 001').toUpperCase(),{w:700,ls:.2});
    var role=String(crew.role||ROLES[0]).toUpperCase().slice(0,22),fs=role.length>16?40:role.length>12?46:52,tw=Math.min(404,role.length*fs*.6),by=168;
    s+='<path fill="'+(M?'url(#'+pre+'gm)':V.light?V.ink:'rgba(3,3,7,.68)')+'" d="M'+(RX+18)+' '+by+'H'+(W-14)+'V'+(by+72)+'H'+RX+'z"/>'
      +'<path fill="url(#'+pre+'ban)" d="M'+(RX+18)+' '+by+'H'+(RX+34)+'L'+(RX+16)+' '+(by+72)+'H'+RX+'z"/>'
      +'<path fill="url(#'+pre+'ban)" d="M'+(RX+18)+' '+by+'H'+(W-14)+'V'+(by+3)+'H'+(RX+17.25)+'z"/><path fill="url(#'+pre+'ban)" d="M'+(RX+.75)+' '+(by+69)+'H'+(W-14)+'V'+(by+72)+'H'+RX+'z"/>'
      +text(RX+44,by+37+fs*.35,fs,'#FFFFFF',role,{w:900,i:true,ls:-.035,len:Math.min(tw,390)});
    s+='<circle cx="604" cy="300" r="31" fill="url(#'+pre+'frame)"/>';
    if(crew.avatar){s+='<image href="'+AV+'" x="577" y="273" width="54" height="54" preserveAspectRatio="xMidYMid slice" clip-path="url(#'+pre+'av)"'+AF+'/>';}else{s+='<circle cx="604" cy="300" r="27" fill="'+C.canvas+'"/>'+helmet(586,289,36,C.punch)+'';}
    var h=handleOf(crew);s+=text(650,313,h.length>15?28:34,V.ink,h,{w:800,ls:-.025,len:h.length>15?354:null});
    s+='<line x1="'+RX+'" y1="354" x2="1004" y2="354" stroke="'+V.ink+'" stroke-width="1.5" opacity=".18"/>';
    var cn=crewNo(crew),numFill=V.light?V.ink:'#FFFFFF';
    s+=text(RX,392,13,V.sub,'CREW NO.',{w:800,ls:.22});
    if(T&&T.pixelNumber)s+='<g opacity=".5" transform="translate(5 5)" fill="#000">'+pixelCrewNumber(cn,RX+4,420,10)+'</g><g fill="#FFFFFF">'+pixelCrewNumber(cn,RX,420,10)+'</g>';
    else{
      if(!V.light)s+=text(RX,487,84,'#000',cn,{w:900,i:true,ls:-.04,len:cn.length>5?262:null,op:.45});
      if(MD)s+=text(RX,487,84,'#000',cn,{w:900,i:true,ls:-.04,len:cn.length>5?262:null,op:.6})+text(RX-4,482,84,'#FFFFFF',cn,{w:900,i:true,ls:-.04,len:cn.length>5?262:null});
      else if(M)s+=text(RX-4,484,84,'#FFFFFF',cn,{w:900,i:true,ls:-.04,len:cn.length>5?262:null,op:.55})+text(RX-4,482,84,'#0E1016',cn,{w:900,i:true,ls:-.04,len:cn.length>5?262:null});
      else s+=text(RX-4,482,84,numFill,cn,{w:900,i:true,ls:-.04,len:cn.length>5?262:null});
    }
    if(T){
      s+=text(RX,530,15,V.ink,(ONE?'1 OF 1':T.label)+(T.stage?'  ·  '+T.stage:''),{w:800,ls:.16});
      s+=text(RX,556,13,V.sub,T.line2||('PRE-REGISTERED  ·  '+String(crew.launch||'LAUNCH 2026').toUpperCase()),{w:700,ls:.14});
      s+=recBy(RX,582,crew,V);
      s+=patch(940,440,T.badge?T:ONE&&!T.patchNum?Object.assign({},T,{patchTop:'ONE OF',patchNum:'ONE'}):(ONE&&!SP?Object.assign({},T,{patchTop:'ONE OF',patchNum:'ONE'}):T),pre,C.paper);
    }else{
      s+=text(RX,530,13,V.sub,'PRE-REGISTERED  ·  '+String(crew.launch||'LAUNCH 2026').toUpperCase(),{w:700,ls:.14})+recBy(RX,556,crew,V);
      ['BSTR','GUID','FIDO','COMM','RTRO','SURG'].forEach(function(l,n){var x=886+(n%3)*46,y=416+Math.floor(n/3)*62;s+='<circle cx="'+x+'" cy="'+y+'" r="7" fill="'+C.go+'"/><circle cx="'+x+'" cy="'+y+'" r="13" fill="'+C.go+'" opacity=".22"/>'+text(x,y+28,9.5,V.sub,l,{w:700,ls:.12,a:'middle'});});
    }

    /* go / no-go poll across the foot of the card */
    /* the countdown along the foot: T-5 to LIFTOFF, the last cell lit */
    var recruitFoot=crew.recruitTotal==null?null:Math.max(0,Math.floor(Number(crew.recruitTotal)||0)),recruitHandles=Array.isArray(crew.recruitHandles)?crew.recruitHandles.slice(0,5):[];
    function shortHandle(value){var h='@'+String(value||'').replace(/^@+/,''),max=15;return h.length>max?h.slice(0,max-3)+'...':h;}
    (recruitFoot==null?['T-5','T-4','T-3','T-2','T-1','BLASTOFF']:[0,1,2,3,4,5].map(function(n){if(n===5)return 'BLASTOFF';return recruitHandles[n]?shortHandle(recruitHandles[n]):'OPEN';})).forEach(function(l,n){var gw=151,x=48+n*(gw+10),last=n===5,lit=recruitFoot==null?(last||(T&&T.litFrom!=null&&n>=T.litFrom)):last||n<recruitHandles.length;s+='<rect x="'+x+'" y="640" width="'+gw+'" height="34" rx="7" fill="'+(lit?(MD?'url(#'+pre+'ban)':M?'url(#'+pre+'gm)':CH?'url(#'+pre+'ban)':ST.stroke):ST.fill)+'" stroke="'+ST.stroke+'" stroke-opacity="'+(lit?1:.6)+'"/>'+text(x+gw/2,662,lit?12:11.5,lit?(MD?'#0A0A12':M?'#FFFFFF':CH?'#0A0A12':(V.light?'#FFFFFF':'#07070D')):ST.text,l.replace('-','−'),{w:lit?900:800,ls:.08,a:'middle',i:lit});});
    if(CH){s+=glint(42,30,1.1)+glint(W-70,H-20,1)+glint(W-22,150,.8,.8)+glint(20,H-190,.7,.7)+glint(RX+30,420,.8,.9)+glint(W-40,176,.7,.8)+glint(1005,398,.6,.8);}
    if(ONE&&T.stamp!==false){var ox=PX+PS-64,oy=PY-4;
      s+='<g transform="rotate(-9 '+ox+' '+oy+')"><rect x="'+(ox-78)+'" y="'+(oy-38)+'" width="156" height="76" rx="12" fill="#07070D" stroke="url(#'+pre+'tf)" stroke-width="4"/><rect x="'+(ox-70)+'" y="'+(oy-30)+'" width="140" height="60" rx="8" fill="url(#'+pre+'holo)" opacity=".22"/>'
        +text(ox,oy+14,42,'url(#'+pre+'tn)','1/1',{w:900,i:true,ls:-.02,a:'middle',stroke:'#07070D',sw:2.4})+text(ox,oy+31,10,'#FFFFFF','ONE OF ONE',{w:800,ls:.3,a:'middle',op:.85})+text(ox,oy-22,9,'#FFFFFF',T.stampTop||'SECRET RARE',{w:800,ls:.24,a:'middle',op:.8})+'</g>'+glint(ox+66,oy-30,.9);}
    return '<svg xmlns="http://www.w3.org/2000/svg" width="'+W*(scale||1)+'" height="'+H*(scale||1)+'" viewBox="0 0 '+W+' '+H+'"><defs>'+defs+'</defs>'+s+'</svg>';
  }

  /* Share image for the X post, 1200 x 675: the card (tilted, with a shadow) on a blurred, darkened copy of itself without the person (just the card's colours), and the campaign text on the right.
     The card is drawn once (<g id>) and reused, so the file stays the size of one card. */
  function shareSVG(crew,edition,pre){
    pre=pre||'sh';
    var SW=1200,SH=675,card=cardSVG(crew,edition,1,pre+'c-'),inner=card.slice(card.indexOf('>')+1,card.lastIndexOf('</svg>'));
    var cw=760,ch=cw*H/W,cx=46,cy=(SH-ch)/2+6,k=cw/W,bk=Math.max(SW/W,SH/H)*1.5,line='I’ve been recruited.',h=handleOf(crew);
    var T=SPECIALS[edition]||TIERS[edition];
    var defs='<g id="'+pre+'card">'+inner+'</g>'
      +'<filter id="'+pre+'bl" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="80" edgeMode="duplicate"/><feColorMatrix type="saturate" values="1.35"/></filter>'
      +'<linearGradient id="'+pre+'dk" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#05060A" stop-opacity=".5"/><stop offset=".55" stop-color="#05060A" stop-opacity=".62"/><stop offset="1" stop-color="#05060A" stop-opacity=".8"/></linearGradient>'
      +'<filter id="'+pre+'sh" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur in="SourceAlpha" stdDeviation="16"/><feOffset dy="18"/><feComponentTransfer><feFuncA type="linear" slope=".6"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>';
    /* the backdrop leaves the person out: the photo and the small avatar are covered with the card's own background before blurring */
    var bf='url(#'+pre+'c-'+(T&&T.metal&&T.chrome?'plate':'bg')+')',pf='<rect x="'+(PX-18)+'" y="'+(PY-18)+'" width="'+(PS+36)+'" height="'+(PS+36)+'" rx="46" fill="'+bf+'"/><circle cx="604" cy="300" r="34" fill="'+bf+'"/>';
    var s='<rect width="'+SW+'" height="'+SH+'" fill="#05060A"/><g filter="url(#'+pre+'bl)"><g transform="translate('+r2((SW-W*bk)/2)+' '+r2((SH-H*bk)/2)+') scale('+r2(bk)+')"><use href="#'+pre+'card"/>'+pf+'</g></g><rect width="'+SW+'" height="'+SH+'" fill="url(#'+pre+'dk)"/>';
    s+='<g filter="url(#'+pre+'sh)" transform="rotate(-3 '+r2(cx+cw/2)+' '+r2(cy+ch/2)+')"><use href="#'+pre+'card" transform="translate('+r2(cx)+' '+r2(cy)+') scale('+r2(k)+')"/></g>';
    var tierLine=T?(T.one?(T.shareLine||'1 OF 1'):T.label+'  ·  '+T.name.toUpperCase()):'RECRUIT  ·  '+String(crew.flight||'FLIGHT 001').toUpperCase(),
      tierCol=T?(T.shareAccent||(T.metal==='dark'?'#FF8CC6':T.metal?'#BFE9FF':T.theme&&T.theme.light?'#FFC6E3':T.accent)):C.kicker,tx=846,words=line.split(' '),l1=words.slice(0,Math.ceil(words.length/2)).join(' '),l2=words.slice(Math.ceil(words.length/2)).join(' ');
    s+=lockup(tx,92,150,C.punch,C.paper)+text(tx,210,13,tierCol,tierLine,{w:800,ls:.14,len:tierLine.length>30?318:null})+text(tx-3,292,62,C.paper,l1,{w:900,i:true,ls:-.045,len:l1.length>12?318:null})+text(tx-3,356,62,C.punch,l2,{w:900,i:true,ls:-.045,len:l2.length>12?318:null})
      +text(tx,414,22,C.paper,h,{w:800,ls:-.01,len:h.length>20?318:null})+text(tx,444,17,'#B8C2CC',String(crew.role||ROLES[0])+'  ·  Crew '+crewNo(crew),{w:500})
      +'<rect x="'+tx+'" y="510" width="232" height="50" rx="8" fill="'+(T&&(T.metal===true||T.shareMetalButton)?'url(#'+pre+'c-ban)':C.punch)+'"/>'+text(tx+116,542,17,C.canvas,'Now recruiting',{w:700,a:'middle'})+text(tx,600,16,'#B8C2CC','blast.fun',{w:600});
    return '<svg xmlns="http://www.w3.org/2000/svg" width="'+SW+'" height="'+SH+'" viewBox="0 0 '+SW+' '+SH+'"><defs>'+defs+'</defs>'+s+'</svg>';
  }
  return {cardSVG:cardSVG,shareSVG:shareSVG,backgroundSVG:function(edition){return cardSVG({},edition,2,"bg-",true);}};
}
module.exports=makeEditionArtwork;
