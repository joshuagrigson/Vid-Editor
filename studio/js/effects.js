// FrightCut effects library — every effect is a WebGL2 (GLSL ES 3.00) fragment body.
// Contract: see SHADER_HEADER / buildFragment / EFFECTS / TRANSITIONS / LOOKS below.
// All effects: amt (u_amt) = 0 returns the untouched input. Extra params -> u_p.xyzw in order.

// ---------------------------------------------------------------------------
// 3x5 pixel font (used for camcorder / CCTV / spirit-box overlays)
// ---------------------------------------------------------------------------
const FONT_CHARS = '0123456789:RECPLAYMSTBNOI. -/DGHVKUWF%+';
const FONT = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '001', '010', '010'],
  '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'],
  ':': ['000', '010', '000', '010', '000'], 'R': ['110', '101', '110', '101', '101'],
  'E': ['111', '100', '110', '100', '111'], 'C': ['111', '100', '100', '100', '111'],
  'P': ['110', '101', '110', '100', '100'], 'L': ['100', '100', '100', '100', '111'],
  'A': ['010', '101', '111', '101', '101'], 'Y': ['101', '101', '010', '010', '010'],
  'M': ['101', '111', '111', '101', '101'], 'S': ['011', '100', '010', '001', '110'],
  'T': ['111', '010', '010', '010', '010'], 'B': ['110', '101', '110', '101', '110'],
  'N': ['110', '101', '101', '101', '101'], 'O': ['010', '101', '101', '101', '010'],
  'I': ['111', '010', '010', '010', '111'], '.': ['000', '000', '000', '000', '010'],
  ' ': ['000', '000', '000', '000', '000'], '-': ['000', '000', '111', '000', '000'],
  '/': ['001', '001', '010', '100', '100'], 'D': ['110', '101', '101', '101', '110'],
  'G': ['011', '100', '101', '101', '011'], 'H': ['101', '101', '111', '101', '101'],
  'V': ['101', '101', '101', '101', '010'], 'K': ['101', '101', '110', '101', '101'],
  'U': ['101', '101', '101', '101', '111'], 'W': ['101', '101', '111', '111', '101'],
  'F': ['111', '100', '110', '100', '100'], '%': ['101', '001', '010', '100', '101'],
  '+': ['000', '010', '111', '010', '000'],
};
function glyphFn() {
  let s = 'int glyphBits(int c){\n';
  [...FONT_CHARS].forEach((ch, i) => {
    const rows = FONT[ch];
    const bits = parseInt(rows.join(''), 2);
    s += `  if(c==${i}) return ${bits};\n`;
  });
  return s + '  return 0;\n}\n';
}
// GLSL function that draws a constant string. p is in font units (char = 3x5, advance 4), origin bottom-left.
function strFn(name, str) {
  const codes = [...str.toUpperCase()].map((ch) => Math.max(0, FONT_CHARS.indexOf(ch)));
  let s = `float ${name}(vec2 p){\n  if(p.x<0.||p.y<0.||p.y>=5.) return 0.;\n  int i=int(floor(p.x/4.));\n  if(i>=${codes.length}) return 0.;\n  int c=26;\n`;
  codes.forEach((c, i) => { s += `  if(i==${i}) c=${c};\n`; });
  return s + '  return drawChar(c,vec2(p.x-float(i)*4.,p.y));\n}\n';
}

// ---------------------------------------------------------------------------
// Shared shader header
// ---------------------------------------------------------------------------
export const SHADER_HEADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_tex;
uniform sampler2D u_prev;
uniform vec2 u_res;
uniform float u_time;
uniform float u_local;
uniform float u_dur;
uniform float u_amt;
uniform vec4 u_p;
uniform float u_seed;
uniform float u_prog;
uniform float u_side;
in vec2 v_uv;
out vec4 outColor;
#define PI 3.14159265359
#define TAU 6.28318530718
// --- hashes (sine-free, Dave Hoskins style) ---
float hash11(float p){p=fract(p*.1031);p*=p+33.33;p*=p+p;return fract(p);}
float hash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
vec2 hash22(vec2 p){vec3 p3=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973));p3+=dot(p3,p3.yzx+33.33);return fract((p3.xx+p3.yz)*p3.zy);}
float hash13(vec3 p3){p3=fract(p3*.1031);p3+=dot(p3,p3.zyx+31.32);return fract((p3.x+p3.y)*p3.z);}
// --- noise ---
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
  float a=hash12(i),b=hash12(i+vec2(1.,0.)),c=hash12(i+vec2(0.,1.)),d=hash12(i+vec2(1.,1.));
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);
  for(int i=0;i<5;i++){v+=a*vnoise(p);p=m*p+vec2(17.3,9.1);a*=.5;}return v/.97;}
float fbm3(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);
  for(int i=0;i<3;i++){v+=a*vnoise(p);p=m*p+vec2(17.3,9.1);a*=.5;}return v/.875;}
// --- color ---
float luma(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
vec3 rgb2hsv(vec3 c){vec4 K=vec4(0.,-1./3.,2./3.,-1.);vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));
  vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));float d=q.x-min(q.w,q.y);float e=1.0e-10;
  return vec3(abs(q.z+(q.w-q.y)/(6.*d+e)),d/(q.x+e),q.x);}
vec3 hsv2rgb(vec3 c){vec3 p=abs(fract(c.xxx+vec3(1.,2./3.,1./3.))*6.-3.);return c.z*mix(vec3(1.),clamp(p-1.,0.,1.),c.y);}
vec3 saturate3(vec3 c,float s){return mix(vec3(luma(c)),c,s);}
vec3 screenB(vec3 a,vec3 b){return 1.-(1.-a)*(1.-b);}
vec3 heatPal(float t){t=clamp(t,0.,1.);
  vec3 c=mix(vec3(0.,0.,.06),vec3(.22,0.,.5),smoothstep(0.,.2,t));
  c=mix(c,vec3(.78,0.,.55),smoothstep(.2,.4,t));
  c=mix(c,vec3(1.,.25,.05),smoothstep(.4,.6,t));
  c=mix(c,vec3(1.,.78,0.),smoothstep(.6,.8,t));
  return mix(c,vec3(1.,1.,.88),smoothstep(.8,1.,t));}
// --- geometry ---
mat2 rot2(float a){float c=cos(a),s=sin(a);return mat2(c,s,-s,c);}
float minres(){return min(u_res.x,u_res.y);}
// centred coords: shorter side spans -0.5..0.5, circles are round
vec2 aspectUV(vec2 uv){return (uv-.5)*u_res/minres();}
vec2 fromAspect(vec2 a){return a*minres()/u_res+.5;}
vec2 extA(){return .5*u_res/minres();}            // half extents of the frame in aspect units
float ss(float a,float b,float x){float t=clamp((x-a)/(b-a),0.,1.);return t*t*(3.-2.*t);} // smoothstep, any edge order
float sdBox(vec2 p,vec2 b){vec2 d=abs(p)-b;return length(max(d,0.))+min(max(d.x,d.y),0.);}
float smin(float a,float b,float k){float h=clamp(.5+.5*(b-a)/k,0.,1.);return mix(b,a,h)-k*h*(1.-h);}
float vigE(vec2 uv){vec2 d=(uv-.5)*2.;return dot(d,d)*.5;} // 0 centre, .5 edge middles, 1 corners
// --- sampling ---
vec4 samp(vec2 uv){return texture(u_tex,clamp(uv,0.,1.));}
vec3 tex(vec2 uv){return texture(u_tex,clamp(uv,0.,1.)).rgb;}
vec3 prevTex(vec2 uv){return texture(u_prev,clamp(uv,0.,1.)).rgb;}
vec3 srcC(){return texture(u_tex,v_uv).rgb;}
// 12-tap golden-angle disc blur; r = radius as a fraction of the shorter side
vec3 blur12(vec2 uv,float r){vec3 acc=vec3(0.);vec2 sc=r*minres()/u_res;
  for(int i=0;i<12;i++){float fi=float(i)+.5;float rr=sqrt(fi/12.);float a=fi*2.39996323;acc+=tex(uv+vec2(cos(a),sin(a))*rr*sc);}
  return acc/12.;}
vec3 blur6(vec2 uv,float r){vec3 acc=vec3(0.);vec2 sc=r*minres()/u_res;
  for(int i=0;i<6;i++){float fi=float(i)+.5;float rr=sqrt(fi/6.);float a=fi*2.39996323;acc+=tex(uv+vec2(cos(a),sin(a))*rr*sc);}
  return acc/6.;}
// --- misc ---
float pxScale(){return max(1.,minres()/720.);}
float grain(float fps){return hash13(vec3(floor(gl_FragCoord.xy/pxScale()),floor(u_time*fps)+u_seed*173.))-.5;}
float scanl(float n){return .5+.5*sin(v_uv.y*u_res.y/minres()*n*PI);}
float bayer4(vec2 p){ivec2 q=ivec2(mod(p,4.));int i=q.x+q.y*4;
  float b[16]=float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);return (b[i]+.5)/16.;}
// normalised life of a one-shot instance (default duration d when the instance spans a whole clip)
float lifeT(float d){float D=u_dur>0.?u_dur:d;return clamp(u_local/D,0.,1.);}
float lifeD(float d){return u_dur>0.?u_dur:d;}
// transitions: 0 at both ends, 1 at the cut
float tpeak(){return clamp(1.-abs(u_prog*2.-1.),0.,1.);}
void emit(vec3 src,vec3 fx){outColor=vec4(clamp(mix(src,fx,clamp(u_amt,0.,1.)),0.,1.),1.);}
void emitc(vec3 c){outColor=vec4(clamp(c,0.,1.),1.);}
// humanoid silhouette SDF: ~1 unit tall, feet at y=-.5
float sdFigure(vec2 p){
  float head=length((p-vec2(0.,.36))*vec2(1.,.82))-.085;
  float neck=sdBox(p-vec2(0.,.25),vec2(.032,.05));
  float sh=length((p-vec2(0.,.15))*vec2(.85,2.))-.16;
  vec2 q=p-vec2(0.,-.14);float w=.15+.035*clamp(-q.y/.34,-1.,1.);
  float torso=sdBox(q,vec2(w,.34))-.03;
  float d=smin(head,neck,.03);d=smin(d,sh,.05);return smin(d,torso,.05);}
// --- 3x5 font ---
${glyphFn()}
float drawChar(int c,vec2 p){
  if(p.x<0.||p.y<0.||p.x>=3.||p.y>=5.) return 0.;
  int bits=glyphBits(c);int x=int(p.x);int y=4-int(p.y);
  return float((bits>>((4-y)*3+(2-x)))&1);}
float drawDigit(int d,vec2 p){return drawChar(d,p);}
// HH:MM:SS (8 chars)
float drawClock(vec2 p,float secs){
  if(p.x<0.||p.y<0.||p.y>=5.) return 0.;
  int i=int(floor(p.x/4.));if(i>7) return 0.;
  float s=floor(max(secs,0.));
  int hh=int(mod(floor(s/3600.),24.));int mm=int(mod(floor(s/60.),60.));int sc=int(mod(s,60.));
  int c=10;
  if(i==0)c=hh/10;else if(i==1)c=hh-(hh/10)*10;else if(i==3)c=mm/10;else if(i==4)c=mm-(mm/10)*10;
  else if(i==6)c=sc/10;else if(i==7)c=sc-(sc/10)*10;
  return drawChar(c,vec2(p.x-float(i)*4.,p.y));}
`;

export function buildFragment(body) {
  return SHADER_HEADER + '\n' + body;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
export const CATEGORIES = [
  { id: 'camera', name: 'Camera', icon: '📹' },
  { id: 'glitch', name: 'Glitch', icon: '📼' },
  { id: 'distort', name: 'Distort', icon: '🌀' },
  { id: 'color', name: 'Color', icon: '🎨' },
  { id: 'supernatural', name: 'Supernatural', icon: '👻' },
  { id: 'light', name: 'Light', icon: '🔦' },
  { id: 'film', name: 'Film', icon: '🎞️' },
  { id: 'blur-motion', name: 'Blur & Motion', icon: '💨' },
  { id: 'frame', name: 'Frames & Masks', icon: '🖼️' },
  { id: 'scare', name: 'Scares', icon: '😱' },
];

// param helpers
const A = (def = 0.8, label = 'Intensity') => ({ k: 'amt', label, min: 0, max: 1, step: 0.01, def });
const P = (k, label, min, max, def, step) => ({
  k, label, min, max, def,
  step: step ?? ((max - min) <= 2 ? 0.01 : (max - min) <= 20 ? 0.1 : 1),
});
const fx = (id, name, cat, desc, params, glsl, extra = {}) => ({ id, name, cat, desc, params, glsl, ...extra });

// ---------------------------------------------------------------------------
// EFFECTS
// ---------------------------------------------------------------------------
export const EFFECTS = [
  // ======================= CAMERA =======================
  fx('night-vision', 'Night Vision', 'camera', 'Green infrared camcorder with blooming highlights and sensor noise.',
    [A(0.9), P('gain', 'Gain', 0.5, 4, 1.8), P('noise', 'Noise', 0, 1, 0.5), P('bloom', 'Bloom', 0, 1, 0.6)], `
void main(){
  vec3 src=srcC();
  vec3 bl=blur12(v_uv,.035);
  float l=luma(src)*u_p.x;
  float b=max(luma(bl)*u_p.x-.7,0.);
  float g=l/(1.+l*.3)*1.15+b*u_p.z*1.4;
  g+=grain(30.)*u_p.y*.55*(1.-.4*min(g,1.));
  g*=1.-.08*scanl(270.);
  g*=.93+.07*vnoise(vec2(u_time*14.,u_seed*40.));
  g*=mix(.2,1.,ss(1.05,.25,vigE(v_uv)));
  vec3 c=vec3(.1,1.,.25)*g;
  c=mix(c,vec3(.8,1.,.8),smoothstep(.85,1.5,g));
  emit(src,c);
}`),

  fx('heat-hunter', 'Heat Hunter', 'camera', 'Thermal-camera heat map: warm bodies burn white-hot, cold rooms go deep blue.',
    [A(1), P('soft', 'Softness', 0, 1, 0.4), P('shift', 'Heat Shift', -0.4, 0.4, 0), P('noise', 'Noise', 0, 1, 0.4)], `
void main(){
  vec3 src=srcC();
  vec3 b=blur12(v_uv,.003+.025*u_p.x);
  float h=dot(b,vec3(.5,.38,.12));
  h=smoothstep(.03,.92,h);
  h+=length(src-b)*.35;
  vec2 a=aspectUV(v_uv);
  h+=(fbm3(a*3.+vec2(u_seed*17.,u_time*.25))-.5)*.12;
  h+=grain(12.)*u_p.z*.15;
  emit(src,heatPal(clamp(h+u_p.y,0.,1.)));
}`),

  fx('security-cam', 'Security Cam', 'camera', 'CCTV: washed-out cold image, choppy frame rate, camera label and timestamp.',
    [A(1), P('choppy', 'Choppiness', 0, 1, 0.4), P('noise', 'Noise', 0, 1, 0.5), P('osd', 'Show Text', 0, 1, 1, 1)], `
${strFn('camLbl', 'CAM 03')}
${strFn('dateLbl', '10-31-2026')}
void main(){
  vec3 src=srcC();
  vec2 a=v_uv-.5;
  vec2 uv=.5+a*(1.+.2*dot(a,a))/1.1;
  vec3 c=tex(uv);
  vec3 f=mix(vec3(luma(c)),c,.22)*vec3(.9,1.,1.06);
  f=(f-.5)*1.2+.47;
  float fps=mix(30.,3.,u_p.x);
  float fr=floor(u_time*fps);
  f+=(hash13(vec3(floor(gl_FragCoord.xy/max(1.,minres()/540.)),fr+u_seed*31.))-.5)*u_p.y*.22;
  f*=1.-.07*scanl(200.);
  f*=1.-.35*smoothstep(.3,1.,vigE(v_uv));
  float px=max(2.,floor(minres()*.0075));
  vec2 fc=gl_FragCoord.xy;
  float txt=camLbl((fc-vec2(px*5.,u_res.y-px*10.))/px);
  txt+=dateLbl((fc-vec2(px*5.,px*5.))/px);
  txt+=drawClock((fc-vec2(u_res.x-px*36.,px*5.))/px,3.*3600.+754.+floor(u_seed*3000.)+u_time);
  vec2 rp=(fc-vec2(u_res.x-px*8.,u_res.y-px*7.5))/px;
  float rec=ss(2.2,1.6,length(rp))*step(.5,fract(u_time*.8));
  f=mix(f,vec3(.95),clamp(txt,0.,1.)*u_p.z);
  f=mix(f,vec3(1.,.15,.1),rec*u_p.z);
  if(u_p.x>.01&&floor(u_time*fps)==floor((u_time-1./30.)*fps)) f=texture(u_prev,v_uv).rgb;
  emit(src,f);
}`, { feedback: true }),

  fx('handheld-shake', 'Handheld Shake', 'camera', 'Nervous handheld camera wobble — someone is filming while scared.',
    [A(0.5, 'Strength'), P('speed', 'Speed', 0.1, 4, 1), P('roll', 'Roll', 0, 1, 0.5)], `
void main(){
  float t=u_time*max(u_p.x,.05)+u_seed*100.;
  vec2 o=vec2(vnoise(vec2(t*1.1,1.7)),vnoise(vec2(t*1.1,9.2)))-.5;
  o+=(vec2(vnoise(vec2(t*4.3,3.1)),vnoise(vec2(t*4.3,5.9)))-.5)*.35;
  float ang=(vnoise(vec2(t*.9,13.))-.5)*.08*u_p.y;
  vec2 a=aspectUV(v_uv);
  a=rot2(ang*u_amt)*a/(1.+.08*u_amt)+o*.05*u_amt;
  emitc(tex(fromAspect(a)));
}`),

  fx('focus-hunt', 'Focus Hunting', 'camera', 'Autofocus pumping in and out, never quite finding the subject.',
    [A(0.8), P('speed', 'Speed', 0.1, 4, 1)], `
void main(){
  float t=u_local*max(u_p.x,.05)+u_seed*50.;
  float hunt=abs(sin(t*2.1+sin(t*.63)*2.5));
  hunt*=smoothstep(.25,.65,vnoise(vec2(t*.5,3.)));
  hunt=max(hunt,.2+.15*vnoise(vec2(t*2.5,9.)));
  float k=hunt*u_amt;
  vec2 a=aspectUV(v_uv)*(1.-.02*k);
  emitc(blur12(fromAspect(a),.03*k));
}`),

  fx('auto-gain', 'Auto-Gain Pump', 'camera', 'Exposure surging up and down like a cheap camera fighting the dark.',
    [A(0.7), P('speed', 'Speed', 0.1, 4, 1)], `
void main(){
  vec3 src=srcC();
  float t=u_time*max(u_p.x,.05)+u_seed*30.;
  float g=(vnoise(vec2(t*1.2,1.))-.5)*1.8+(vnoise(vec2(t*5.,5.))-.5)*.5;
  float gain=exp2(g*1.6);
  vec3 c=src*gain;
  c=mix(c,vec3(luma(c)),clamp((gain-1.)*.2,0.,.4));
  c+=grain(30.)*max(gain-1.,0.)*.2;
  emit(src,c);
}`),

  fx('lens-dirt', 'Dirty Lens', 'camera', 'Smudges and dust on the lens that light up around bright lights.',
    [A(0.8), P('haze', 'Haze', 0, 1, 0.4)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);
  float d=smoothstep(.45,.85,fbm(a*2.5+u_seed*20.));
  vec2 g=a*6.;vec2 id=floor(g);vec2 r=hash22(id+u_seed*13.);
  float s=ss(.3,.05,length(fract(g)-.5-(r-.5)*.5))*step(.55,hash12(id+3.1));
  float sm=smoothstep(.6,.9,vnoise(vec2(a.x*2.+a.y*14.,u_seed*5.)))*.5;
  float dirt=clamp(d*.8+s*.7+sm,0.,1.);
  vec3 glow=blur12(v_uv,.07);
  vec3 bright=max(glow-.4,0.)*1.8;
  vec3 c=src*(1.-.12*dirt)+bright*(.15+dirt*1.6)*vec3(1.,.93,.82);
  c=mix(c,glow,u_p.x*.35*(.4+dirt));
  emit(src,c);
}`),

  fx('jello-wobble', 'Rolling Shutter', 'camera', 'Jelly-like rolling-shutter wobble from a shaky phone sensor.',
    [A(0.6), P('speed', 'Speed', 0.1, 4, 1)], `
void main(){
  float t=u_time*max(u_p.x,.05)+u_seed*40.;
  float j=(vnoise(vec2(t*3.,2.))-.5)*2.;
  float sx=minres()/u_res.x;
  float off=sin(v_uv.y*8.+t*12.)*j*.025+(vnoise(vec2(v_uv.y*25.,t*15.))-.5)*.008;
  off+=(v_uv.y-.5)*j*.05;
  emitc(tex(v_uv+vec2(off*sx*u_amt,0.)));
}`),

  fx('low-battery', 'Low Battery', 'camera', 'Camera dying: dim flickering picture, dropouts and a blinking battery icon.',
    [A(0.8), P('rate', 'Flicker Rate', 0.1, 4, 1)], `
void main(){
  vec3 src=srcC();
  float t=u_time*max(u_p.x,.05)+u_seed*20.;
  float drop=step(.72,vnoise(vec2(t*2.5,1.)));
  float fl=.7+.3*vnoise(vec2(t*25.,4.));
  vec3 c=saturate3(src,.55)*fl*(1.-.8*drop)*.85;
  c+=grain(24.)*.1;
  c*=1.-.05*scanl(220.);
  float px=max(1.5,minres()*.0045);
  vec2 p=(gl_FragCoord.xy-vec2(u_res.x-px*22.,u_res.y-px*14.))/px;
  float bd=sdBox(p-vec2(7.,3.5),vec2(7.,3.5));
  float frame=step(abs(bd),.6)+step(sdBox(p-vec2(15.,3.5),vec2(.9,1.5)),0.);
  float bar=step(sdBox(p-vec2(2.2,3.5),vec2(1.,2.)),0.);
  float blink=step(.5,fract(u_time*1.4));
  c=mix(c,vec3(.95),clamp(frame,0.,1.)*blink);
  c=mix(c,vec3(1.,.12,.08),bar*blink);
  emit(src,c);
}`),

  fx('cctv-fisheye', 'CCTV Fisheye', 'camera', 'Wide-angle barrel lens with dark falloff, like a corner security camera.',
    [A(0.7)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);vec2 e=extA();
  float r2=dot(a,a);float k=u_amt*1.3;float m2=dot(e,e);
  vec2 s=a*(1.+k*r2)/(1.+k*m2*.45);
  vec2 uv=fromAspect(s);
  vec3 c=tex(uv);
  float o=max(max(-uv.x,uv.x-1.),max(-uv.y,uv.y-1.));
  c*=ss(.008,-.004,o);
  c*=1.-.5*smoothstep(.15,1.,r2/m2);
  emit(src,c);
}`),

  fx('full-spectrum', 'Full-Spectrum Cam', 'camera', 'Ghost-hunter full-spectrum camera: false-colour infrared magenta with glowing halos.',
    [A(0.9), P('glow', 'Glow', 0, 1, 0.6)], `
void main(){
  vec3 src=srcC();
  vec3 b=blur12(v_uv,.04);
  float l=luma(src);
  vec3 ir=vec3(l*1.05+src.r*.2,src.b*.55+l*.15,src.g*.55+l*.45);
  ir=(ir-.5)*1.15+.5;
  ir+=max(b-.45,0.)*u_p.x*1.6*vec3(1.,.85,1.);
  ir+=grain(30.)*.08;
  ir*=mix(.35,1.,ss(1.,.3,vigE(v_uv)));
  emit(src,ir);
}`),

  fx('creep-zoom', 'Creeping Zoom', 'camera', 'Slow digital zoom creeping toward a spot, getting blockier as it pushes in.',
    [A(1), P('zoom', 'Max Zoom', 1, 4, 2.2), P('x', 'Target X', 0, 1, 0.5), P('y', 'Target Y', 0, 1, 0.55), P('speed', 'Speed', 0.02, 2, 0.25)], `
void main(){
  float g=clamp(u_local*u_p.w,0.,1.);g=g*g*(3.-2.*g);
  float z=1.+(max(u_p.x,1.)-1.)*g*u_amt;
  vec2 c=clamp(vec2(u_p.y,u_p.z),.0,1.);
  vec2 uv=c+(v_uv-c)/z;
  float bs=1.+(z-1.)*.8;
  uv=(floor(uv*u_res/bs)+.5)*bs/u_res;
  vec3 col=tex(uv);
  col=mix(col,(col-.5)*1.08+.5,clamp(z-1.,0.,1.));
  emitc(col);
}`),

  // ======================= GLITCH =======================
  fx('rgb-split', 'RGB Split', 'glitch', 'Colour channels tear apart and jitter.',
    [A(0.6), P('dist', 'Distance', 0, 1, 0.5), P('jitter', 'Jitter', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  float t=u_time;
  float ang=t*.7+u_seed*6.28+(vnoise(vec2(t*3.,1.))-.5)*u_p.y*4.;
  float burst=1.+3.*step(.86,hash11(floor(t*12.)+u_seed*9.))*u_p.y;
  vec2 d=vec2(cos(ang),sin(ang)*.35)*.025*u_p.x*u_amt*(.5+.8*vnoise(vec2(t*6.,5.)))*burst;
  d*=minres()/u_res;
  emitc(vec3(tex(v_uv+d).r,src.g,tex(v_uv-d).b));
}`),

  fx('datamosh', 'Datamosh', 'glitch', 'Compression meltdown: blocks of the last frame smear and bleed into the new one.',
    [A(0.7), P('block', 'Block Size', 8, 64, 24, 1), P('chaos', 'Chaos', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  float bs=max(u_p.x,4.)*minres()/1080.;
  vec2 bid=floor(gl_FragCoord.xy/bs);
  float tq=floor(u_time*5.)+u_seed*50.;
  float region=vnoise(bid*.12+vec2(tq*1.7,tq*.3));
  float mosh=smoothstep(.62-.4*u_p.y,.7-.4*u_p.y,region);
  vec2 mv=(hash22(floor(bid/3.)+tq)-.5)*bs*3./u_res;
  mv.y-=bs*.6/u_res.y;
  vec3 pv=prevTex(v_uv+mv);
  vec3 res=src-tex(v_uv+mv);
  vec3 moshed=pv+res*.3;
  float q=step(.9,hash12(bid+tq));
  moshed=mix(moshed,floor(moshed*4.)/4.+vec3(0.,.08,0.),q*mosh);
  emitc(mix(src,moshed,mosh*u_amt));
}`, { feedback: true }),

  fx('signal-tear', 'Signal Tear', 'glitch', 'Horizontal bands rip sideways with flashes of inverted signal.',
    [A(0.7), P('bands', 'Bands', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  float t=floor(u_time*15.)+u_seed*30.;
  float y=v_uv.y;
  float band=floor(y*mix(8.,40.,hash11(t*1.3)));
  float h=hash12(vec2(band,t));
  float on=step(1.-u_p.x*.45*u_amt,h);
  float sh=(hash12(vec2(band,t+7.))-.5)*.25*on;
  float ty=hash11(t*.71);
  float tear=ss(.06,0.,abs(y-ty))*(hash11(t*3.3)-.5)*.3*step(.4,hash11(t*5.1));
  vec2 uv=vec2(fract(v_uv.x+(sh+tear)*u_amt),v_uv.y);
  vec3 c=tex(uv);
  c.r=tex(uv+vec2(.012*on*u_amt,0.)).r;
  c=mix(c,1.-c,on*step(.82,hash12(vec2(band,t+3.))));
  c+=on*.08*hash12(vec2(floor(gl_FragCoord.x/4.),t));
  emitc(mix(src,c,min(u_amt*4.,1.)));
}`),

  fx('digital-blocks', 'Block Corruption', 'glitch', 'Rectangles of the picture jump, swap colours and posterize like a corrupt file.',
    [A(0.7), P('size', 'Block Size', 0, 1, 0.5), P('rate', 'Rate', 1, 30, 10)], `
void main(){
  vec3 src=srcC();
  float t=floor(u_time*max(u_p.y,1.))+u_seed*17.;
  vec2 a=v_uv*u_res/minres();
  float sz=mix(1.6,.6,u_p.x);
  vec2 b1=floor(a*vec2(3.,10.)*sz);float r1=hash13(vec3(b1,t));
  vec2 b2=floor(a*vec2(10.,26.)*sz);float r2=hash13(vec3(b2,t+3.));
  float sel=max(step(1.-.16*u_amt,r1),step(1.-.1*u_amt,r2));
  vec2 off=(hash22(b1+t)-.5)*vec2(.3,.06)*sel;
  vec3 c=tex(fract(v_uv+off));
  float m=hash13(vec3(b2,t+9.));
  if(sel>.5){
    if(m<.25) c=c.gbr;
    else if(m<.45) c=floor(c*3.)/3.;
    else if(m<.55) c=vec3(c.r,0.,c.b)*1.4;
    else if(m<.65) c=1.-c;
    else if(m<.75) c=vec3(0.,c.g*1.3,0.);
  }
  emitc(c);
}`),

  fx('vhs', 'VHS Tape', 'glitch', 'Worn VHS: smeary colour bleed, wobbling lines, head-switch noise at the bottom.',
    [A(0.85), P('wobble', 'Wobble', 0, 1, 0.5), P('noise', 'Noise', 0, 1, 0.5), P('bleed', 'Colour Bleed', 0, 1, 0.6)], `
void main(){
  vec3 src=srcC();
  float t=u_time;
  vec2 uv=v_uv;
  float line=floor(uv.y*240.);
  float w=(vnoise(vec2(line*.1,t*8.))-.5)*.004*u_p.x+sin(uv.y*3.+t*2.)*.0015*u_p.x;
  float bot=ss(.06,0.,uv.y);
  w+=bot*(vnoise(vec2(t*20.,uv.y*60.))-.3)*.05;
  uv.x+=w;
  float sx=minres()/u_res.x;
  vec3 c=tex(uv);
  float Y=dot(c,vec3(.299,.587,.114));
  vec2 ch=vec2(0.);
  for(int i=0;i<6;i++){
    float o=(float(i)-1.)*.005*u_p.z*sx;
    vec3 s=tex(uv+vec2(o,0.));
    ch+=vec2(dot(s,vec3(.596,-.274,-.322)),dot(s,vec3(.211,-.523,.312)));
  }
  ch/=6.;
  vec3 yiq=vec3(Y,ch*.9);
  vec3 rgb=vec3(dot(yiq,vec3(1.,.956,.621)),dot(yiq,vec3(1.,-.272,-.647)),dot(yiq,vec3(1.,-1.106,1.703)));
  float fr=floor(t*30.);
  float nl=step(.996-.012*u_p.y,hash12(vec2(floor(uv.y*u_res.y/2.),fr)));
  rgb+=nl*step(.4,hash12(vec2(floor(gl_FragCoord.x/(20.*pxScale())),fr+uv.y*100.)))*.7;
  rgb+=grain(30.)*.1*u_p.y;
  rgb=mix(rgb,vec3(hash12(gl_FragCoord.xy+fr)),bot*.5);
  rgb=saturate3(rgb,.85)*.93+.04;
  rgb*=1.-.06*scanl(240.);
  emit(src,rgb);
}`),

  fx('tracking-error', 'Tracking Error', 'glitch', 'A band of rolling VHS tracking noise crawls up the screen.',
    [A(0.8), P('speed', 'Speed', 0, 2, 0.3), P('size', 'Band Size', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  float t=u_time*u_p.x+u_seed;
  float y=v_uv.y;
  float bpos=fract(t*.6);
  float d=abs(y-bpos);d=min(d,1.-d);
  float bw=mix(.03,.15,u_p.y);
  float inb=ss(bw,0.,d);
  float fr=floor(u_time*30.);
  float jit=(vnoise(vec2(y*80.,u_time*30.))-.5)*.12*inb+(hash12(vec2(floor(y*u_res.y/3.),fr))-.5)*.04*inb;
  vec2 uv=vec2(fract(v_uv.x+jit*u_amt),v_uv.y+inb*.01*sin(u_time*40.)*u_amt);
  vec3 c=tex(uv);
  float sn=hash13(vec3(gl_FragCoord.xy,fr));
  float nm=inb*step(.45,vnoise(vec2(gl_FragCoord.x*.02/pxScale()+u_time*50.,y*200.)));
  c=mix(c,vec3(sn),nm*.85*u_amt);
  c*=1.-inb*.25*u_amt;
  c.r=mix(c.r,tex(uv+vec2(.01*inb*u_amt,0.)).r,inb);
  emitc(c);
}`),

  fx('tv-static', 'TV Static', 'glitch', 'Analog snow with a rolling hum bar; the picture fights through.',
    [A(0.6), P('roll', 'Roll Bar', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  float fr=floor(u_time*30.)+u_seed*99.;
  float s=max(1.,minres()/540.);
  float n=hash13(vec3(floor(gl_FragCoord.xy/s),fr));
  float ln=hash12(vec2(floor(gl_FragCoord.y/(2.*s)),fr));
  n=mix(n,ln,.25);
  float roll=fract(v_uv.y+u_time*.7);
  float rb=smoothstep(0.,.1,roll)*ss(.3,.12,roll);
  vec3 st=vec3(n)*(1.-.4*rb*u_p.x);
  vec3 c=st*.85+(src-.5)*.3+.1;
  emit(src,c);
}`),

  fx('no-signal', 'No Signal', 'glitch', 'Colour bars and a NO SIGNAL card with static, the feed occasionally breaking through.',
    [A(1), P('static', 'Static', 0, 1, 0.3)], `
${strFn('noSig', 'NO SIGNAL')}
void main(){
  vec3 src=srcC();
  vec2 uv=v_uv;
  int i=clamp(int(floor(uv.x*7.)),0,6);
  vec3 T[7]=vec3[7](vec3(.75),vec3(.75,.75,0.),vec3(0.,.75,.75),vec3(0.,.75,0.),vec3(.75,0.,.75),vec3(.75,0.,0.),vec3(0.,0.,.75));
  vec3 M[7]=vec3[7](vec3(0.,0.,.75),vec3(.07),vec3(.75,0.,.75),vec3(.07),vec3(0.,.75,.75),vec3(.07),vec3(.75));
  vec3 c=T[i];
  if(uv.y<.33) c=M[i];
  if(uv.y<.25){int j=clamp(int(floor(uv.x*5.)),0,4);
    vec3 B[5]=vec3[5](vec3(0.,.13,.3),vec3(1.),vec3(.2,0.,.42),vec3(.03),vec3(.06));c=B[j];}
  float fr=floor(u_time*30.);
  float n=hash13(vec3(floor(gl_FragCoord.xy/max(1.,minres()/540.)),fr));
  c=mix(c,vec3(n),u_p.x*.6);
  float brk=step(.88,hash11(floor(u_time*8.)+u_seed*13.));
  float strip=step(.5,hash12(vec2(floor(uv.y*30.),fr)));
  c=mix(c,src,brk*strip*.8);
  float px=max(2.,floor(minres()*.012));
  vec2 cen=u_res*.5;
  vec2 bp=gl_FragCoord.xy-cen;
  float box=step(sdBox(bp,vec2(px*20.,px*5.)),0.);
  c=mix(c,vec3(0.),box*.85);
  float tx=noSig((gl_FragCoord.xy-cen+vec2(px*17.5,px*2.5))/px);
  c=mix(c,vec3(1.),tx*step(.3,fract(u_time*1.2)));
  emit(src,c);
}`),

  fx('pixel-drip', 'Pixel Drip', 'glitch', 'Pixel-sorting streaks: bright pixels melt down the frame in glitchy columns.',
    [A(0.8), P('length', 'Length', 0, 1, 0.5), P('thresh', 'Threshold', 0, 1, 0.45)], `
void main(){
  vec3 src=srcC();
  float col=floor(v_uv.x*u_res.x/max(1.,minres()/540.));
  float L=mix(.04,.35,u_p.x)*(.35+.65*hash11(col*.13+u_seed*10.));
  L*=.8+.2*sin(u_time*1.3+col*.05);
  vec3 best=src;float bl=luma(src);
  for(int i=1;i<=16;i++){
    float o=float(i)/16.;
    vec3 s=tex(v_uv+vec2(0.,o*L));
    float ls=luma(s);
    float l=ls*step(u_p.y,ls)*(1.-o*.3);
    if(l>bl){best=s;bl=l;}
  }
  emit(src,best);
}`),

  fx('interlace', 'Interlace Comb', 'glitch', 'Old interlaced video: alternate lines lag a frame behind, combing on motion.',
    [A(0.8)], `
void main(){
  vec3 src=srcC();
  float lh=max(1.,floor(minres()/540.+.5));
  float line=mod(floor(gl_FragCoord.y/lh),2.);
  vec2 jit=vec2((hash11(floor(u_time*30.)+u_seed)-.5)*.008,0.);
  vec3 c=src;
  if(line>.5) c=mix(prevTex(v_uv+jit),src,.2)*.92;
  else c=tex(v_uv-jit*.5);
  emit(src,c);
}`, { feedback: true }),

  fx('bitcrush', 'Bit Crush', 'glitch', 'Low-colour dithered pixels like a cursed 8-bit video game.',
    [A(1), P('levels', 'Colour Levels', 2, 16, 4, 1), P('pixel', 'Pixel Size', 1, 32, 4, 1)], `
void main(){
  vec3 src=srcC();
  float bs=max(1.,floor(u_p.y*max(1.,minres()/540.)));
  vec2 cell=floor(gl_FragCoord.xy/bs);
  vec3 c=tex((cell+.5)*bs/u_res);
  float lv=max(u_p.x,2.)-1.;
  float d=bayer4(cell)-.5;
  c=floor(c*lv+.5+d*.9)/lv;
  emit(src,c);
}`),

  fx('corrupt-file', 'Corrupt File', 'glitch', 'Broken compression: macroblocks, colour-shifted chunks and smeared rows.',
    [A(0.8), P('size', 'Block Size', 0, 1, 0.4)], `
void main(){
  vec3 src=srcC();
  float bs=8.*max(1.,minres()/540.)*mix(1.,3.,u_p.x);
  vec2 b=floor(gl_FragCoord.xy/bs);vec2 f=fract(gl_FragCoord.xy/bs);
  vec2 c0=(b+.5)*bs/u_res;vec2 h=bs*.3/u_res;
  vec3 A=tex(c0-h),B=tex(c0+vec2(h.x,-h.y)),C=tex(c0+vec2(-h.x,h.y)),D=tex(c0+h);
  vec3 blk=mix(mix(A,B,f.x),mix(C,D,f.x),f.y);
  float t=floor(u_time*6.)+u_seed*7.;
  float region=smoothstep(.45,.55,vnoise(b*.15+vec2(t*3.1,t)));
  vec3 c=mix(src,blk,region);
  float r=hash13(vec3(b,t));
  if(r>.93) c+=vec3(-.25,.3,-.25)*cos(f.x*PI*2.)*cos(f.y*PI);
  else if(r>.88) c=c.brg*vec3(1.2,.9,1.1);
  else if(r<.05) c=tex(vec2(c0.x,c0.y+bs*4./u_res.y));
  float row=step(.97,hash12(vec2(b.y,t)));
  c=mix(c,tex(vec2(c0.x*.2,v_uv.y)),row);
  emit(src,c);
}`),

  // ======================= DISTORT =======================
  fx('haunted-ripple', 'Haunted Ripple', 'distort', 'Slow rings ripple out from the centre like a disturbed pool.',
    [A(0.5), P('freq', 'Frequency', 0, 1, 0.5), P('speed', 'Speed', 0, 4, 1)], `
void main(){
  vec2 a=aspectUV(v_uv);
  float r=length(a);
  float w=sin(r*mix(15.,60.,u_p.x)-u_time*u_p.y*3.)*.012*u_amt*smoothstep(0.,.15,r);
  a+=a/max(r,1e-4)*w+vec2(sin(a.y*8.+u_time*1.3),cos(a.x*7.-u_time))*.004*u_amt;
  emitc(tex(fromAspect(a)));
}`),

  fx('heat-haze', 'Heat Haze', 'distort', 'Shimmering air rising off something hot — or something wrong.',
    [A(0.5), P('speed', 'Speed', 0, 4, 1), P('scale', 'Scale', 0, 1, 0.5)], `
void main(){
  vec2 a=aspectUV(v_uv);
  float t=u_time*u_p.x;
  vec2 q=a*mix(3.,12.,u_p.y)+vec2(0.,-t*1.5);
  vec2 d=vec2(fbm3(q),fbm3(q+vec2(5.2,1.3)))-.5;
  a+=d*.035*u_amt;
  emitc(tex(fromAspect(a)));
}`),

  fx('vortex', 'Vortex', 'distort', 'The middle of the frame twists into a slowly turning whirlpool.',
    [A(0.6), P('radius', 'Radius', 0, 1, 0.6), P('spin', 'Spin', -2, 2, 0.3)], `
void main(){
  vec2 a=aspectUV(v_uv);float r=length(a);float R=mix(.2,.9,u_p.x);
  float f=ss(R,0.,r);
  float ang=(f*f*6.*(1.+.3*sin(u_time*.7))+f*u_time*u_p.y)*u_amt;
  emitc(tex(fromAspect(rot2(ang)*a)));
}`),

  fx('breathing-walls', 'Breathing Walls', 'distort', 'The whole room slowly inhales and exhales.',
    [A(0.5), P('rate', 'Breaths/sec', 0.05, 2, 0.3)], `
void main(){
  vec2 a=aspectUV(v_uv);float r=length(a);
  float br=sin(u_time*u_p.x*TAU+u_seed*6.)*.5+.5;br=br*br*(3.-2.*br);
  float k=(br-.4)*.35*u_amt;
  a*=1.-k*(1.-clamp(r*r*2.,0.,1.));
  a+=(vec2(fbm3(a*2.+u_time*.2),fbm3(a*2.+7.-u_time*.2))-.5)*.03*u_amt;
  vec3 c=tex(fromAspect(a));
  c*=1.-.25*br*u_amt*smoothstep(.2,1.,vigE(v_uv));
  emitc(c);
}`),

  fx('nightmare-kaleido', 'Nightmare Kaleidoscope', 'distort', 'Mirrored slices spin around the centre — pure fever dream.',
    [A(1), P('segments', 'Segments', 2, 12, 6, 1), P('spin', 'Spin', -1, 1, 0.15)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);float r=length(a);
  float an=atan(a.y,a.x+1e-6)+u_time*u_p.y;
  float n=floor(max(u_p.x,2.));float seg=TAU/n;
  an=mod(an,seg);an=min(an,seg-an);
  vec2 k=vec2(cos(an),sin(an))*r*(1.+.06*sin(u_time*.9));
  emit(src,tex(fromAspect(k)));
}`),

  fx('melt', 'Melt', 'distort', 'The picture drips and slides downward, melting more the longer it runs.',
    [A(0.7), P('speed', 'Speed', 0, 2, 0.4), P('drips', 'Drip Detail', 0, 1, 0.5)], `
void main(){
  float t=min(u_local*u_p.x+.6,4.);
  float x=v_uv.x*u_res.x/minres();
  float d=fbm3(vec2(x*mix(3.,12.,u_p.y)+u_seed*30.,u_seed*3.));
  float fine=pow(vnoise(vec2(x*40.,u_seed*9.)),4.);
  float drip=(d*d*1.6+fine*.6)*t*.18*u_amt;
  float wob=(vnoise(vec2(v_uv.y*10.,x*5.+u_time*.5))-.5)*.006*u_amt;
  vec2 uv=v_uv+vec2(wob*minres()/u_res.x,drip);
  vec3 c=tex(uv);
  c*=1.-clamp(drip*1.2,0.,.35);
  emitc(c);
}`),

  fx('funhouse-stretch', 'Funhouse Stretch', 'distort', 'Faces stretch long and thin like a warped mirror.',
    [A(0.6), P('speed', 'Speed', 0, 3, 0.5)], `
void main(){
  vec2 a=aspectUV(v_uv);
  float k=u_amt*(.7+.3*sin(u_time*u_p.x*2.+u_seed*6.));
  float g=exp(-dot(a,a)*5.);
  a.y*=1.-.45*k*g;
  a.x*=1.+.35*k*g;
  emitc(tex(fromAspect(a)));
}`),

  fx('glass-crack', 'Cracked Lens', 'distort', 'Shattered glass in front of the lens; each shard refracts differently.',
    [A(0.85), P('x', 'Impact X', 0, 1, 0.58), P('y', 'Impact Y', 0, 1, 0.6), P('shards', 'Shards', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv)-aspectUV(vec2(u_p.x,u_p.y));
  float r=length(a)+1e-5;float an=atan(a.y,a.x+1e-6);
  float n=floor(mix(9.,24.,u_p.z));
  vec2 q=vec2((an/TAU+.5)*n,log(r)*3.2);
  vec2 ip=floor(q),fp=fract(q);
  float f1=8.,f2=8.;vec2 cid=vec2(0.);
  for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){
    vec2 g=vec2(float(i),float(j));vec2 id=ip+g;id.x=mod(id.x,n);
    vec2 o=hash22(id+u_seed*31.)*.9+.05;
    vec2 d=g+o-fp;float dd=dot(d,d);
    if(dd<f1){f2=f1;f1=dd;cid=id;}else if(dd<f2)f2=dd;
  }
  float edge=(sqrt(f2)-sqrt(f1))*r/3.2;
  float reach=ss(.95,.25,r+(fbm3(a*4.)-.5)*.4);
  float crack=ss(.0035,.0005,edge)*reach;
  vec2 off=(hash22(cid+3.)-.5)*.025*reach;
  vec3 col=tex(v_uv+off*minres()/u_res);
  col*=1.+(hash12(cid)-.5)*.25*reach;
  col=mix(col,vec3(.92,.95,1.),crack*.75);
  col+=ss(.06,0.,r)*.5;
  emit(src,col);
}`),

  fx('lens-drops', 'Rain On Lens', 'distort', 'Water drops cling to and slide down the lens, each one a tiny upside-down world.',
    [A(0.8), P('size', 'Drop Size', 0, 1, 0.5), P('speed', 'Slide Speed', 0, 2, 0.4)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);
  vec2 off=vec2(0.);float mask=0.;float rim=0.;float hi=0.;
  for(int L=0;L<2;L++){
    float fl=float(L);
    float sc=mix(9.,4.,u_p.x)*(1.+fl*.7);
    vec2 q=a*sc;
    float colid=floor(q.x);
    q.y+=u_time*u_p.y*fl*(.5+hash11(colid+u_seed*13.));
    vec2 id=floor(q);vec2 f=fract(q)-.5;
    vec2 h=hash22(id+fl*17.+u_seed*9.);
    float rad=mix(.12,.32,h.x)*step(.35,h.y);
    vec2 p=f-(h-.5)*.4;
    p.y*=mix(1.,.75,fl);
    float d=length(p)/max(rad,1e-3);
    float m=ss(1.,.85,d)*step(.001,rad);
    off+=-p*m*1.8/sc;
    mask=max(mask,m);
    rim=max(rim,smoothstep(.6,.95,d)*m);
    hi=max(hi,ss(.18,.0,length(p/max(rad,1e-3)-vec2(-.3,.35)))*m);
  }
  vec3 c=tex(fromAspect(a+off));
  vec3 bg=mix(src,blur6(v_uv,.006),.6);
  c=mix(bg,c,mask);
  c*=1.-.45*rim;
  c+=hi*.5;
  emit(src,c);
}`),

  fx('endless-corridor', 'Endless Corridor', 'distort', 'The frame repeats inside itself forever, pulling you deeper into the dark.',
    [A(0.85), P('speed', 'Speed', -1, 1, 0.25), P('depth', 'Loop Scale', 1.3, 4, 2)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);vec2 e=extA();
  vec2 n=a/e;
  float r=max(max(abs(n.x),abs(n.y)),1e-4);
  float z=max(u_p.y,1.2);
  float k=log(r)/log(z)-u_time*u_p.x;
  float f=fract(k);
  float rr=pow(z,f-1.);
  vec2 s=n/r*rr*.985;
  vec3 c=tex(fromAspect(s*e));
  float depth=clamp(-log(r)/log(z)/3.,0.,1.);
  c*=mix(1.,.15,depth);
  c*=1.-.25*ss(.95,1.,rr);
  emit(src,c);
}`),

  // ======================= COLOR =======================
  fx('bleach-bypass', 'Bleach Bypass', 'color', 'Gritty, desaturated, high-contrast silver look.',
    [A(0.8)], `
void main(){
  vec3 src=srcC();
  float l=luma(src);
  vec3 lo=2.*src*l;vec3 hi=1.-2.*(1.-src)*(1.-l);
  vec3 ov=mix(lo,hi,smoothstep(.45,.55,l));
  vec3 c=mix(ov,vec3(l),.4);
  c=(c-.5)*1.12+.5;
  emit(src,c);
}`),

  fx('red-keep', 'Blood Red Isolate', 'color', 'Everything goes grey except the reds — blood, lips, a red balloon.',
    [A(1), P('tol', 'Tolerance', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  vec3 hsv=rgb2hsv(src);
  float hd=min(hsv.x,1.-hsv.x);
  float keep=ss(.06+.1*u_p.x,.015,hd)*smoothstep(.15,.4,hsv.y)*smoothstep(.08,.2,hsv.z);
  vec3 g=vec3(luma(src));g=(g-.5)*1.15+.48;
  vec3 red=src*vec3(1.2,.85,.85);
  emit(src,mix(g,red,keep));
}`),

  fx('witching-blue', 'Witching Hour', 'color', 'Cold 3 a.m. moonlight blue with deep shadows.',
    [A(0.85)], `
void main(){
  vec3 src=srcC();
  float l=luma(src);
  vec3 c=saturate3(src,.35)*vec3(.72,.9,1.18)+vec3(0.,.02,.07)*(1.-l);
  c=pow(max(c,0.),vec3(1.12));
  c*=1.-.35*smoothstep(.25,1.,vigE(v_uv));
  emit(src,c);
}`),

  fx('sepia', 'Old Sepia', 'color', 'Faded brown photograph tones.',
    [A(0.9), P('fade', 'Fade', 0, 1, 0.3)], `
void main(){
  vec3 src=srcC();
  vec3 c=vec3(dot(src,vec3(.393,.769,.189)),dot(src,vec3(.349,.686,.168)),dot(src,vec3(.272,.534,.131)));
  c=mix(c,c*.8+vec3(.12,.1,.07),u_p.x);
  emit(src,c);
}`),

  fx('negative', 'Negative', 'color', 'Inverted film negative; slide Ghost toward an X-ray glow.',
    [A(1), P('xray', 'X-Ray', 0, 1, 0)], `
void main(){
  vec3 src=srcC();
  vec3 inv=1.-src;
  vec3 x=vec3(1.-luma(src));x=pow(x,vec3(1.4))*vec3(.75,.92,1.15);
  emit(src,mix(inv,x,u_p.x));
}`),

  fx('duotone', 'Duotone', 'color', 'Two-colour gradient map; defaults to dried blood and bone.',
    [A(1), P('dark', 'Shadow Hue', 0, 1, 0.98), P('light', 'Highlight Hue', 0, 1, 0.11), P('contrast', 'Contrast', 0.5, 2, 1.2)], `
void main(){
  vec3 src=srcC();
  float l=clamp((luma(src)-.5)*u_p.z+.5,0.,1.);
  vec3 a=hsv2rgb(vec3(u_p.x,.85,.22));vec3 b=hsv2rgb(vec3(u_p.y,.3,1.));
  emit(src,mix(a,b,l*l*(3.-2.*l)));
}`),

  fx('sick-green', 'Sick Green', 'color', 'Cross-processed nausea: sallow greens, crushed blues, rotten skin tones.',
    [A(0.85)], `
void main(){
  vec3 src=srcC();
  vec3 c=src;
  c.r=smoothstep(.06,.95,c.r);
  c.g=pow(c.g,.8)*1.05;
  c.b=c.b*.55+.1;
  c=mix(c,c*vec3(.85,1.1,.72),.6);
  c=saturate3(c,.8);
  emit(src,c);
}`),

  fx('posterize-nightmare', 'Posterize Nightmare', 'color', 'Flat poster colours that slowly cycle through sickly hues.',
    [A(0.9), P('levels', 'Levels', 2, 8, 4, 1), P('cycle', 'Colour Cycle', 0, 1, 0.15)], `
void main(){
  vec3 src=srcC();
  float lv=max(u_p.x,2.);
  float l=luma(src);
  float q=floor(l*lv)/(lv-1.);
  vec3 post=floor(src*lv)/(lv-1.);
  vec3 hue=hsv2rgb(vec3(fract(q*.45+u_time*u_p.y*.2+u_seed),.75,.15+.85*q));
  emit(src,mix(post,hue,.55));
}`),

  fx('crush', 'Crushed Blacks', 'color', 'Deep inky shadows and punchy contrast — things hide in the dark.',
    [A(0.8), P('crush', 'Crush', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  float k=u_p.x*.3;
  vec3 c=max(src-k,0.)/(1.-k);
  c=c*c*(3.-2.*c);
  c=saturate3(c,.85);
  emit(src,c);
}`),

  fx('desaturate', 'Desaturate', 'color', 'Drain the colour out of the world.',
    [A(1), P('contrast', 'Contrast', 0.5, 2, 1.1)], `
void main(){
  vec3 src=srcC();
  vec3 g=vec3((luma(src)-.5)*u_p.x+.5);
  emit(src,g);
}`),

  fx('color-drain', 'Colour Drain', 'color', 'Colour slowly bleeds out of the scene over time, leaving it cold and grey.',
    [A(1), P('time', 'Drain Seconds', 0.2, 10, 3)], `
void main(){
  vec3 src=srcC();
  float k=smoothstep(0.,max(u_p.x,.1),u_local);
  vec3 g=vec3(luma(src))*vec3(.92,.97,1.05);
  g=(g-.5)*(1.+.15*k)+.5;
  emit(src,mix(src,g,k));
}`),

  fx('infernal', 'Infernal', 'color', 'Hellfire grade: black-red shadows, ember highlights, flickering firelight.',
    [A(0.85), P('flicker', 'Flicker', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  float l=luma(src);
  float fl=1.+(vnoise(vec2(u_time*9.,u_seed*20.))-.5)*.35*u_p.x;
  l*=fl;
  vec3 c=mix(vec3(.03,0.,0.),vec3(.55,.02,0.),smoothstep(0.,.35,l));
  c=mix(c,vec3(1.,.45,.05),smoothstep(.3,.75,l));
  c=mix(c,vec3(1.,.92,.6),smoothstep(.75,1.1,l));
  emit(src,c);
}`),

  // ======================= SUPERNATURAL =======================
  fx('ghost-double', 'Ghost Double', 'supernatural', 'A pale translucent copy of the scene drifts out of sync with reality.',
    [A(0.6), P('drift', 'Drift', 0, 1, 0.5), P('speed', 'Speed', 0, 3, 0.4)], `
void main(){
  vec3 src=srcC();
  float t=u_time*u_p.y+u_seed*10.;
  vec2 o=vec2(sin(t*1.3)+.5*sin(t*2.7),cos(t*.9)*.6)*.045*u_p.x;
  float sc=1.+.05*sin(t*.8);
  vec2 a=aspectUV(v_uv);
  vec3 g=tex(fromAspect((a-o)/sc));
  g=vec3(luma(g))*vec3(.8,.95,1.15);
  float vis=.45+.25*vnoise(vec2(t*3.,4.));
  vec3 c=screenB(src*.92,g*vis);
  emit(src,c);
}`),

  fx('spirit-trails', 'Spirit Trails', 'supernatural', 'Anything that moves leaves glowing ghostly afterimages that drift upward.',
    [A(0.7), P('decay', 'Trail Length', 0, 1, 0.6), P('rise', 'Rise', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);
  vec3 p=prevTex(fromAspect(a*(1.-.006*u_p.y))+vec2(0.,-.003*u_p.y));
  float decay=mix(.7,.96,u_p.x);
  vec3 tr=p*decay*vec3(.88,.97,1.08);
  vec3 c=max(src,tr);
  c=mix(c,(src+tr)*.5,.35);
  emit(src,c);
}`, { feedback: true }),

  fx('apparition', 'Shadow Figure', 'supernatural', 'A dark human silhouette flickers into the room for a split second at a time.',
    [A(0.9), P('x', 'Position', 0, 1, 0.7), P('size', 'Size', 0.2, 1.2, 0.7), P('flicker', 'Flicker', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);vec2 e=extA();
  float sz=u_p.y;
  vec2 pos=vec2(aspectUV(vec2(u_p.x,0.)).x,-e.y+sz*.5+.02);
  vec2 p=(a-pos)/sz;
  float t=u_time+u_seed*30.;
  p+=(vec2(fbm3(p*3.+t*.6),fbm3(p*3.-t*.5))-.5)*.08;
  float d=sdFigure(p);
  float m=ss(.04,-.04,d+(fbm3(p*10.+t)-.5)*.05);
  float halo=ss(.25,0.,d)*.4;
  float vis=mix(1.,step(.45,vnoise(vec2(t*5.,1.)))*(.6+.4*hash11(floor(t*24.))),u_p.z);
  float k=(m*.9+halo*.5)*vis;
  vec3 c=src*(1.-k)+vec3(.01,0.,.02)*k;
  c*=1.-.25*vis*u_p.z*step(.5,vis);
  emit(src,c);
}`),

  fx('pale-figure', 'Pale Figure', 'supernatural', 'A translucent glowing ghost stands in the room, bending the light behind it.',
    [A(0.8), P('x', 'Position', 0, 1, 0.3), P('size', 'Size', 0.2, 1.2, 0.75), P('sway', 'Sway', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);vec2 e=extA();
  float sz=u_p.y;float t=u_time*.7+u_seed*20.;
  vec2 pos=vec2(aspectUV(vec2(u_p.x,0.)).x,-e.y+sz*.5+.03);
  vec2 p=(a-pos)/sz;
  p.x+=sin(p.y*6.+t*2.)*.02*u_p.z;
  vec2 w=vec2(fbm3(p*4.+t),fbm3(p*4.-t+3.))-.5;
  float d=sdFigure(p+w*.06);
  float m=ss(.03,-.06,d);
  float edge=ss(.05,0.,abs(d));
  float fadeLegs=smoothstep(-.55,-.15,p.y);
  m*=fadeLegs;edge*=fadeLegs;
  vec3 bg=tex(v_uv+w*.03*m);
  float pulse=.65+.35*vnoise(vec2(t*3.,2.));
  vec3 c=bg+vec3(.72,.85,1.)*(m*.28+edge*.45)*pulse;
  c=mix(c,vec3(luma(c))*vec3(.9,.97,1.1),m*.6);
  emit(src,c);
}`),

  fx('demon-glow', 'Demon Glow', 'supernatural', 'The brightest spots — eyes, lamps, screens — burn infernal red while the rest sinks into darkness.',
    [A(0.85), P('thresh', 'Threshold', 0.3, 1, 0.68)], `
void main(){
  vec3 src=srcC();
  vec3 bl=blur12(v_uv,.03);
  float l=luma(src);
  float hl=smoothstep(u_p.x,u_p.x+.12,l);
  float glow=smoothstep(u_p.x-.15,1.,luma(bl));
  float pulse=.8+.2*sin(u_time*3.+u_seed*6.);
  vec3 base=src*vec3(.7,.55,.55)*.75;
  vec3 c=mix(base,vec3(1.,.15,.05)*1.2,hl);
  c+=vec3(1.,.08,.02)*glow*1.6*pulse;
  emit(src,c);
}`),

  fx('lurking-eyes', 'Lurking Eyes', 'supernatural', 'A pair of glowing eyes watches from the dark… and blinks.',
    [A(1), P('x', 'X', 0, 1, 0.5), P('y', 'Y', 0, 1, 0.62), P('size', 'Size', 0, 1, 0.35), P('hue', 'Colour', 0, 0.2, 0.02)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv)-aspectUV(vec2(u_p.x,u_p.y));
  float s=mix(.015,.1,u_p.z);
  a/=s;
  a+=vec2(sin(u_time*.5+u_seed*9.),cos(u_time*.37+u_seed*3.))*.08;
  float bt=fract(u_time*.21+u_seed);
  float blink=smoothstep(.0,.035,abs(bt-.5));
  vec2 e=rot2(.28)*vec2(abs(a.x)-1.15,a.y);
  float h=.42*blink+.03;
  float d=length(vec2(e.x/.8,e.y/(h*.8+.001)));
  float eye=ss(1.,.82,d);
  vec3 iris=hsv2rgb(vec3(u_p.w,.95,1.))*mix(1.4,.6,length(e));
  float pupil=ss(.11,.06,abs(e.x))*step(abs(e.y),h);
  vec3 ecol=mix(iris,vec3(0.),pupil*.9);
  float glow=exp(-length(e)*1.6)*.9*(.4+.6*blink);
  vec3 c=src*(1.-.4*exp(-dot(a,a)*.08));
  c=mix(c,ecol,eye);
  c+=hsv2rgb(vec3(u_p.w,.9,1.))*glow*.6;
  emit(src,c);
}`),

  fx('possessed', 'Possessed', 'supernatural', 'Violent red possession: twitching frame, inverted flashes, hellish tint.',
    [A(0.85), P('rate', 'Fit Rate', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  float t=u_time+u_seed*10.;
  float pulse=step(1.-.18*u_p.x,hash11(floor(t*12.)));
  float fit=smoothstep(.5,.75,vnoise(vec2(t*1.2,3.)));
  vec2 sh=(hash22(vec2(floor(t*24.),3.))-.5)*.04*(.25+pulse+fit);
  vec2 a=aspectUV(v_uv)*(1.-.03*fit)+sh*u_amt;
  vec3 c=tex(fromAspect(a));
  float l=luma(c);
  vec3 red=vec3(l*1.35,l*.22,l*.18);
  vec3 f=mix(c*vec3(1.1,.7,.65),red,.65);
  f=mix(f,vec3(1.-l*.2,1.-l,1.-l),pulse);
  f*=1.-.55*smoothstep(.15,1.,vigE(v_uv))*vec3(.6,1.,1.);
  emit(src,f);
}`),

  fx('poltergeist', 'Poltergeist', 'supernatural', 'Sudden bursts of violent shaking as if something grabbed the camera.',
    [A(0.8), P('freq', 'Burst Frequency', 0.1, 3, 1)], `
void main(){
  float t=u_time*u_p.x+u_seed*20.;
  float burst=smoothstep(.62,.78,vnoise(vec2(t*1.5,1.)))*u_amt;
  float tt=u_time+u_seed;
  vec2 o=(vec2(vnoise(vec2(tt*40.,2.)),vnoise(vec2(tt*40.,7.)))-.5)*.09*burst;
  float ang=(vnoise(vec2(tt*30.,4.))-.5)*.18*burst;
  vec2 a=rot2(ang)*aspectUV(v_uv)/(1.+.12*burst)+o;
  vec3 c=tex(fromAspect(a));
  vec3 c2=tex(fromAspect(a+o*.7));
  c=mix(c,c2,.4*burst);
  c*=1.-.15*burst;
  emitc(c);
}`),

  fx('ectoplasm', 'Ectoplasm', 'supernatural', 'Glowing spirit mist curls and flows across the frame.',
    [A(0.7), P('hue', 'Colour', 0, 1, 0.36), P('speed', 'Speed', 0, 2, 0.3), P('density', 'Density', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);float t=u_time*u_p.y+u_seed*10.;
  vec2 q=a*2.5;
  vec2 w=vec2(fbm3(q+vec2(t,0.)),fbm3(q+vec2(3.1,-t*.8)));
  float f=fbm(q+w*2.+vec2(0.,t*.5));
  float m=smoothstep(.5-.25*u_p.z,.88,f);
  vec3 col=mix(hsv2rgb(vec3(u_p.x,.55,1.)),vec3(.95,1.,.95),m*.6);
  vec3 c=screenB(src,col*m*.85);
  emit(src,c);
}`),

  fx('dense-fog', 'Dense Fog', 'supernatural', 'Thick rolling grey fog swallows the scene — you can only see a few feet.',
    [A(0.8), P('density', 'Density', 0, 1, 0.6), P('speed', 'Drift', 0, 2, 0.2)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);float t=u_time*u_p.y+u_seed*7.;
  float n=fbm(a*1.6+vec2(t,t*.3))*.6+fbm3(a*4.5-vec2(t*1.7,0.))*.4;
  float d=clamp(u_p.x*(.45+.75*n)+(v_uv.y-.5)*.2,0.,1.);
  vec3 soft=blur6(v_uv,.008);
  vec3 c=saturate3(mix(src,soft,.6),.55);
  vec3 fog=vec3(.76,.78,.78);
  c=mix(c,fog,d*.9);
  emit(src,c);
}`),

  fx('ash-fall', 'Falling Ash', 'supernatural', 'Grey ash drifts down from the sky like snow from a burning town.',
    [A(0.85), P('density', 'Density', 0, 1, 0.5), P('speed', 'Speed', 0, 2, 0.35), P('size', 'Size', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);float acc=0.;
  for(int L=0;L<3;L++){
    float fl=float(L);
    float sc=mix(5.,13.,fl/2.)/mix(.5,1.5,u_p.z);
    vec2 q=a*sc;
    q.y+=u_time*u_p.y*(2.2-fl*.5)+fl*7.;
    q.x+=sin(q.y*.6+fl*3.+u_time*.5)*.35;
    vec2 id=floor(q);vec2 f=fract(q)-.5;
    vec2 h=hash22(id+fl*11.+u_seed*7.);
    vec2 pp=f-(h-.5)*.6;
    pp=rot2(u_time*(h.x-.5)*4.+h.y*6.)*pp;
    float d=length(pp*vec2(1.,1.9));
    float r=.05+.06*h.x;
    acc+=ss(r,r*.3,d)*(1.-fl*.25)*step(h.y,u_p.x*.9+.05);
  }
  vec3 c=saturate3(src,.8);
  c=mix(c,vec3(.72,.7,.68),clamp(acc,0.,1.)*.9);
  emit(src,c);
}`),

  fx('orbs', 'Spirit Orbs', 'supernatural', 'Glowing dust orbs float through the frame like on ghost-hunting cams.',
    [A(0.8), P('density', 'Density', 0, 1, 0.45), P('speed', 'Speed', 0, 2, 0.4), P('size', 'Size', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);vec3 acc=vec3(0.);
  float t=u_time*u_p.y+u_seed*30.;
  for(int L=0;L<2;L++){
    float fl=float(L);
    float sc=mix(2.5,5.,fl)/mix(.6,1.5,u_p.z);
    vec2 q=a*sc+vec2(sin(t*.15+fl*2.)*1.5,t*.12*(fl+1.));
    vec2 id=floor(q);vec2 f=fract(q)-.5;
    vec2 h=hash22(id+fl*21.+u_seed*5.);
    vec2 pos=(h-.5)*.45+.12*vec2(sin(t*(.5+h.x)+h.y*6.),cos(t*(.4+h.y)+h.x*6.));
    float r=.1+.12*h.x;
    float d=length(f-pos);
    float disc=ss(r,r*.85,d);
    float rimv=smoothstep(r*.6,r*.95,d)*disc;
    float tw=.5+.5*sin(t*3.*(h.x+.3)+h.y*20.);
    float on=step(h.y,u_p.x);
    acc+=(disc*.18+rimv*.35+ss(r*.5,0.,d)*.15)*tw*on*vec3(.85,.95,1.)*(1.-fl*.3);
  }
  emit(src,src+acc);
}`),

  fx('spirit-box', 'Spirit Box', 'supernatural', 'EVP scanner: sweeping static bursts and a voice waveform twitching at the bottom.',
    [A(0.85), P('static', 'Static', 0, 1, 0.6)], `
${strFn('evpLbl', 'EVP')}
void main(){
  vec3 src=srcC();
  float t=u_time+u_seed*20.;
  float fr=floor(t*20.);
  float sweep=fract(t*.8);
  float band=ss(.08,0.,abs(v_uv.y-sweep));
  float burst=step(.6,hash11(fr*.37));
  float n=hash13(vec3(floor(gl_FragCoord.xy/max(1.,minres()/400.)),fr));
  float lines=step(.75,hash12(vec2(floor(v_uv.y*90.),fr)))*burst;
  vec3 c=src*(.85+.15*burst);
  c=mix(c,vec3(n),clamp(band*.6+lines*.45,0.,1.)*u_p.x);
  c=saturate3(c,.6)*vec3(.9,1.,.95);
  vec2 a=aspectUV(v_uv);vec2 e=extA();
  float y0=-e.y+.15;
  float amp=.05*(.3+.7*vnoise(vec2(t*4.,2.)))*(.5+burst);
  float w=sin(a.x*40.+t*30.)*.5+sin(a.x*93.-t*47.)*.3+(vnoise(vec2(a.x*60.,t*25.))-.5)*1.4;
  float dy=abs(a.y-y0-w*amp);
  float panel=step(abs(a.y-y0),.11)*step(abs(a.x),e.x-.04);
  float line=ss(.005,0.,dy)+ss(.03,0.,dy)*.3;
  c=mix(c,c*.3,panel*.75);
  c+=vec3(.3,1.,.5)*line*panel;
  float px=max(2.,floor(minres()*.007));
  vec2 tp=(gl_FragCoord.xy-vec2(fromAspect(vec2(-e.x+.06,y0+.06))*u_res))/px;
  float txt=evpLbl(tp);
  float f=88.+floor(mod(t*7.,200.))/10.;
  vec2 np=tp-vec2(16.,0.);
  int d1=int(mod(floor(f/10.),10.));int d2=int(mod(floor(f),10.));int d3=int(mod(floor(f*10.+.5),10.));
  txt+=drawChar(d1,np)+drawChar(d2,np-vec2(4.,0.))+drawChar(25,np-vec2(8.,0.))+drawChar(d3,np-vec2(12.,0.));
  c=mix(c,vec3(.4,1.,.6),clamp(txt,0.,1.)*panel);
  emit(src,c);
}`),

  fx('mirror-world', 'Mirror World', 'supernatural', 'Half the world is a reflection of the other half — something is off.',
    [A(1), P('axis', 'Vertical Split', 0, 1, 0, 1), P('flip', 'Swap Side', 0, 1, 0, 1)], `
void main(){
  vec3 src=srcC();
  vec2 uv=v_uv;
  float t=u_time;
  if(u_p.x<.5){
    bool right=u_p.y<.5?uv.x>.5:uv.x<.5;
    if(right) uv.x=1.-uv.x;
    uv.x+=sin(uv.y*30.+t*2.)*.0015*ss(.06,0.,abs(v_uv.x-.5));
  }else{
    bool top=u_p.y<.5?uv.y>.5:uv.y<.5;
    if(top) uv.y=1.-uv.y;
    uv.y+=sin(uv.x*30.+t*2.)*.0015*ss(.06,0.,abs(v_uv.y-.5));
  }
  vec3 c=tex(uv);
  float seam=u_p.x<.5?abs(v_uv.x-.5):abs(v_uv.y-.5);
  c+=vec3(.5,.6,.8)*ss(.004,0.,seam)*(.5+.5*sin(t*3.));
  emit(src,c);
}`),

  fx('time-slip', 'Time Slip', 'supernatural', 'Colour channels slip out of time: movement leaves red-now, blue-before echoes.',
    [A(0.8), P('lag', 'Lag', 0, 1, 0.7)], `
void main(){
  vec3 src=srcC();
  vec3 p=prevTex(v_uv);
  vec3 c=vec3(src.r,mix(src.g,p.g,u_p.x*.6),mix(src.b,p.b,u_p.x));
  c=mix(c,c*vec3(1.,.95,1.08),.5);
  emit(src,c);
}`, { feedback: true }),

  fx('shadow-tendrils', 'Shadow Tendrils', 'supernatural', 'Black tendrils of darkness creep in from the edges of the frame.',
    [A(0.85), P('reach', 'Reach', 0, 1, 0.5), P('speed', 'Speed', 0, 2, 0.4)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);vec2 ex=extA();
  vec2 e=ex-abs(a);float de=min(e.x,e.y);
  float an=atan(a.y,a.x+1e-6);
  vec2 ring=vec2(cos(an),sin(an));
  float t=u_time*u_p.y+u_seed*20.;
  float grow=mix(.05,.45,u_p.x)*(.85+.15*sin(t*.8));
  float ten=pow(vnoise(ring*4.+vec2(t*.3,u_seed*9.)),2.5);
  float ten2=pow(vnoise(ring*9.+vec2(-t*.2,3.)),3.);
  float reach=grow*(.25+1.5*ten+ten2);
  float wig=(fbm3(a*7.+vec2(t*.4,-t*.3))-.5)*.08;
  float d=de+wig-reach;
  float m=ss(.03,-.01,d);
  float edgeGlow=ss(.08,0.,abs(d))*.25;
  vec3 c=src*(1.-m*.97)*(1.-edgeGlow*.6);
  c+=vec3(.06,0.,.1)*edgeGlow*(1.-m);
  emit(src,c);
}`),

  fx('dark-presence', 'Dark Presence', 'supernatural', 'An oily darkness creeps in from one side and swallows part of the frame.',
    [A(0.9), P('side', 'Direction', 0, 1, 0), P('speed', 'Creep Speed', 0.02, 2, 0.3), P('reach', 'Reach', 0, 1, 0.6)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);vec2 ex=extA();
  float ang=u_p.x*TAU;vec2 dir=vec2(cos(ang),sin(ang));
  float span=abs(dir.x)*ex.x+abs(dir.y)*ex.y;
  float creep=smoothstep(0.,1.,u_local*u_p.y+.25);
  float s=-dot(a,dir)/span;
  float th=1.05-creep*mix(.4,1.6,u_p.z);
  float n=fbm(a*3.+vec2(u_time*.25,u_seed*9.));
  float d=s+(n-.5)*.45-th;
  float m=smoothstep(-.06,.12,d);
  vec3 c=saturate3(src,1.-m*.8)*(1.-m*.95)+vec3(.01,0.,.02)*m;
  c*=1.-.3*ss(.2,0.,abs(d));
  emit(src,c);
}`),

  // ======================= LIGHT =======================
  fx('flicker-lights', 'Flickering Lights', 'light', 'A dying light bulb: the room stutters in and out of darkness.',
    [A(0.8), P('speed', 'Speed', 0.1, 4, 1)], `
void main(){
  vec3 src=srcC();
  float t=u_time*u_p.x+u_seed*30.;
  float n=vnoise(vec2(t*12.,1.));
  float off=step(.6,vnoise(vec2(t*2.5,4.)))*step(.35,n);
  float hum=step(.5,hash11(floor(t*30.)))*step(.7,vnoise(vec2(t*2.,9.)));
  float b=1.-off*.88-(n-.5)*.15-hum*.4;
  emit(src,src*b);
}`),

  fx('strobe', 'Strobe', 'light', 'Hard strobe light chopping the scene into frozen flashes.',
    [A(0.9), P('rate', 'Flashes/sec', 1, 20, 8), P('duty', 'Light Time', 0.05, 0.9, 0.35)], `
void main(){
  vec3 src=srcC();
  float on=step(fract(u_time*u_p.x+u_seed),u_p.y);
  vec3 c=on>.5?src*1.5+.12:src*.06;
  emit(src,c);
}`),

  fx('lightning', 'Lightning', 'light', 'Stormy blue darkness lit by sudden double-flash lightning strikes.',
    [A(1), P('freq', 'Strikes/sec', 0.05, 2, 0.4)], `
void main(){
  vec3 src=srcC();
  float P=1./max(u_p.x,.02);
  float k=floor(u_time/P);float ts=u_time-k*P;
  float dt=ts-hash11(k+u_seed*7.)*P*.5;
  float f=0.;
  if(dt>0.) f=exp(-dt*10.)+step(.12,dt)*exp(-max(dt-.12,0.)*6.)*.8;
  f*=step(.25,hash11(k*1.7+u_seed));
  f*=.75+.25*hash11(floor(u_time*30.));
  vec3 base=src*vec3(.5,.58,.8)*.65;
  vec3 flash=pow(src,vec3(.55))*vec3(.85,.92,1.2)*1.7+.12;
  emit(src,mix(base,flash,clamp(f,0.,1.)));
}`),

  fx('flashlight', 'Flashlight', 'light', 'Total darkness except a wandering flashlight beam.',
    [A(1), P('size', 'Beam Size', 0.1, 1, 0.35), P('soft', 'Softness', 0, 1, 0.5), P('wander', 'Wander Speed', 0, 2, 0.5)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);vec2 ex=extA();
  float t=u_time*u_p.z+u_seed*20.;
  vec2 c=(vec2(vnoise(vec2(t*.7,1.)),vnoise(vec2(t*.7,5.)))-.5)*ex*1.3;
  c+=(vec2(vnoise(vec2(u_time*6.,2.)),vnoise(vec2(u_time*6.,8.)))-.5)*.015;
  vec2 d=a-c;d.y*=1.08;
  float r=length(d)/u_p.x;
  float spot=ss(1.,1.-u_p.y*.85-.05,r);
  float hot=exp(-r*r*3.)*.4;
  float ring=smoothstep(.7,.92,r)*ss(1.02,.92,r)*.18;
  float fl=.95+.05*vnoise(vec2(u_time*20.,3.));
  float lit=(spot*(1.+hot)+ring)*fl+.025;
  vec3 col=src*lit*vec3(1.08,1.,.88)*1.15;
  emit(src,col);
}`),

  fx('candle-glow', 'Candlelight', 'light', 'Warm flickering candlelight; the edges fall away into black.',
    [A(0.85), P('x', 'Light X', 0, 1, 0.5), P('y', 'Light Y', 0, 1, 0.25), P('flicker', 'Flicker', 0, 1, 0.6)], `
void main(){
  vec3 src=srcC();
  float t=u_time+u_seed*10.;
  float fl=1.+(vnoise(vec2(t*8.,1.))-.5)*.35*u_p.z+(vnoise(vec2(t*23.,3.))-.5)*.15*u_p.z;
  vec2 L=aspectUV(vec2(u_p.x,u_p.y))+(vec2(vnoise(vec2(t*3.,5.)),vnoise(vec2(t*3.,9.)))-.5)*.02;
  float d=length(aspectUV(v_uv)-L);
  float light=fl*1.3/(1.+d*d*9.);
  vec3 warm=src*vec3(1.25,.85,.5);
  vec3 c=warm*light+vec3(1.,.45,.12)*.06*fl*ss(.6,0.,d);
  emit(src,c);
}`),

  fx('emergency-red', 'Emergency Light', 'light', 'Spinning red alarm beacon sweeping across a dark room.',
    [A(0.85), P('speed', 'Speed', 0.1, 4, 1)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);
  float ph=u_time*u_p.x*3.+u_seed*6.;
  float sweep=pow(max(cos(a.x*2.2-ph*1.3),0.),4.);
  float pulse=.5+.5*sin(ph*1.3);
  vec3 base=vec3(luma(src))*vec3(.3,.06,.06);
  vec3 lit=src*vec3(1.7,.28,.22)*(sweep*1.3+pulse*.3);
  emit(src,base+lit);
}`),

  fx('god-rays', 'God Rays', 'light', 'Beams of light stream out from bright areas through dust in the air.',
    [A(0.7), P('x', 'Source X', 0, 1, 0.5), P('y', 'Source Y', 0, 1, 0.8), P('length', 'Length', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  vec2 L=vec2(u_p.x,u_p.y);
  vec2 d=(v_uv-L)*mix(.25,.8,u_p.z)/16.;
  vec3 acc=vec3(0.);float w=1.;vec2 uv=v_uv;
  for(int i=0;i<16;i++){uv-=d;vec3 s=tex(uv);acc+=max(s-.5,0.)*2.*w;w*=.92;}
  acc/=7.;
  float dust=.85+.3*fbm3(aspectUV(v_uv)*6.+u_time*.1);
  emit(src,src+acc*vec3(1.,.95,.82)*dust);
}`),

  fx('bloom', 'Glow Bloom', 'light', 'Dreamy glow bleeding out of every highlight.',
    [A(0.7), P('thresh', 'Threshold', 0, 1, 0.5), P('size', 'Size', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  float r=mix(.02,.07,u_p.y);
  vec3 b1=blur12(v_uv,r*.35),b2=blur12(v_uv,r);
  vec3 g=max(b1-u_p.x,0.)+max(b2-u_p.x,0.)*1.3;
  vec3 c=src+g*1.4;
  c=c/(1.+max(c-1.,0.)*.5);
  emit(src,c);
}`),

  fx('anamorphic-streak', 'Lens Flare Streak', 'light', 'Long blue horizontal flare streaks and ghosts off bright lights.',
    [A(0.75), P('thresh', 'Threshold', 0, 1, 0.6), P('length', 'Length', 0, 1, 0.6)], `
void main(){
  vec3 src=srcC();
  float sx=minres()/u_res.x;
  vec3 acc=vec3(0.);
  for(int i=-8;i<=8;i++){
    float fi=float(i);
    float o=fi*.03*mix(.4,1.4,u_p.y)*sx;
    acc+=max(tex(v_uv+vec2(o,0.))-u_p.x,0.)*exp(-abs(fi)*.25);
  }
  acc*=.35;
  vec3 gh=max(tex(1.-v_uv)-u_p.x,0.)*.6+max(tex((1.-v_uv-.5)*.5+.5)-u_p.x,0.)*.4;
  vec3 c=src+luma(acc)*vec3(.35,.6,1.3)*1.6+gh*vec3(.6,.4,1.);
  emit(src,c);
}`),

  // ======================= FILM =======================
  fx('film-grain', 'Film Grain', 'film', 'Organic, luminance-aware film grain.',
    [A(0.6), P('size', 'Grain Size', 0, 1, 0.4), P('color', 'Colour Grain', 0, 1, 0.2)], `
void main(){
  vec3 src=srcC();
  float s=mix(1.,3.,u_p.x)*pxScale();
  vec2 g=gl_FragCoord.xy/s;
  float fr=floor(u_time*24.)+u_seed*91.;
  vec2 o=hash22(vec2(fr,1.7))*400.;
  float n=vnoise(g+o)+vnoise(g*1.7+o.yx)-1.;
  vec3 cn=vec3(vnoise(g+o+11.),vnoise(g+o+23.),vnoise(g+o+37.))-.5;
  float l=luma(src);
  float w=.3+.7*(1.-pow(abs(l-.45)*2.,2.));
  vec3 c=src+(vec3(n)*(1.-u_p.y)+cn*u_p.y*1.5)*.32*w;
  emit(src,c);
}`),

  fx('scratches-dust', 'Scratches & Dust', 'film', 'Old print damage: vertical scratches, dust specks and the odd hair.',
    [A(0.8), P('dust', 'Dust', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  float fr=floor(u_time*24.)+u_seed*91.;
  float sc=0.;
  for(int i=0;i<3;i++){
    float fi=float(i);
    float k=floor(u_time*24./(4.+fi*3.));
    float x=hash11(k*1.3+fi*7.+u_seed)+sin(u_time*3.+fi)*.003;
    float on=step(.4,hash11(k*2.1+fi));
    float w=(.6+hash11(k+fi*3.))*pxScale()/u_res.x;
    float line=ss(w*1.5,0.,abs(v_uv.x-x))*on*smoothstep(.2,.6,vnoise(vec2(v_uv.y*12.,k+fi)));
    sc+=line;
  }
  vec2 a=aspectUV(v_uv)*28.;vec2 id=floor(a);vec2 h=hash22(id+fr*1.37);
  float speck=step(1.-.02*u_p.x,h.x)*ss(.25*h.y+.08,0.,length(fract(a)-.5-(h-.5)*.4));
  float hk=floor(u_time*24./12.);
  vec2 hp=aspectUV(v_uv)-(hash22(vec2(hk,u_seed))-.5)*.8;
  hp=rot2(hash11(hk)*6.)*hp;
  float hair=ss(.0025,0.,abs(hp.y-sin(hp.x*25.)*.015))*step(abs(hp.x),.07)*step(.6,hash11(hk+.5))*u_p.x;
  float dark=step(.5,h.y);
  vec3 c=src*(1.-speck*dark*.85)+speck*(1.-dark)*.6;
  c=c*(1.-hair*.8)+sc*.45;
  emit(src,c);
}`),

  fx('old-projector', 'Old Projector', 'film', 'Projector gate weave, flicker, uneven exposure and burnt-in vignette.',
    [A(0.85), P('weave', 'Weave', 0, 1, 0.5), P('flicker', 'Flicker', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  float fr=floor(u_time*18.)+u_seed*13.;
  vec2 weave=vec2(vnoise(vec2(fr*.3,1.))-.5,(vnoise(vec2(fr*.5,4.))-.5)*1.5)*.008*u_p.x;
  float jump=step(.985,hash11(fr*.71))*.03;
  vec3 c=tex(v_uv+weave+vec2(0.,jump));
  float fl=1.-u_p.y*.25*hash11(fr);
  c*=fl;
  c*=1.-.12*(fbm3(v_uv*2.+fr*.05)-.5);
  c*=1.-.6*pow(vigE(v_uv),1.4);
  c=(c-.5)*1.08+.5;
  emit(src,c);
}`),

  fx('edge-burn', 'Burning Edges', 'film', 'The film is catching fire — glowing embers eat in from the edges.',
    [A(0.85), P('size', 'Burn Size', 0, 1, 0.4)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);vec2 ex=extA();
  vec2 e=ex-abs(a);float de=min(e.x,e.y);
  float n=fbm(a*4.+vec2(u_time*.08,u_seed*9.));
  float th=mix(.02,.22,u_p.x)*(1.+.25*sin(u_time*.6+n*6.));
  float x=de-(n-.5)*.18-th;
  float fl=.8+.4*vnoise(vec2(u_time*8.,3.));
  float burnt=ss(.0,-.01,x);
  float ember=smoothstep(-.012,0.,x)*ss(.05,0.,x);
  vec3 c=src*mix(vec3(1.),vec3(1.1,.9,.7),ss(.2,0.,x));
  c=mix(c,vec3(.03,.015,.005),burnt);
  c+=vec3(1.,.42,.05)*ember*1.6*fl+vec3(1.,.9,.5)*ss(.012,0.,abs(x))*.8*fl;
  emit(src,c);
}`),

  fx('cinema-bars', 'Cinema Bars', 'film', 'Black letterbox bars slide in for a cinematic frame.',
    [A(1), P('size', 'Bar Size', 0, 0.4, 0.12)], `
void main(){
  vec3 src=srcC();
  float h=u_p.x*u_amt;
  float m=step(v_uv.y,h)+step(1.-h,v_uv.y);
  emitc(src*(1.-clamp(m,0.,1.)));
}`),

  fx('halation', 'Halation', 'film', 'Red-orange film halo blooming around bright edges.',
    [A(0.75), P('thresh', 'Threshold', 0, 1, 0.55)], `
void main(){
  vec3 src=srcC();
  vec3 b=blur12(v_uv,.022);
  float h=max(luma(b)-u_p.x,0.)/(1.-u_p.x+.01);
  vec3 c=src+vec3(1.,.28,.1)*h*.9;
  c=c*vec3(1.02,1.,.97)+.01;
  emit(src,c);
}`),

  fx('cigarette-burns', 'Reel Change Cue', 'film', 'The ominous dot that flashes in the corner before a reel change.',
    [A(1), P('every', 'Every (sec)', 1, 10, 3)], `
void main(){
  vec3 src=srcC();
  float per=max(u_p.x,1.);
  float ph=mod(u_local+2.,per);
  float on=step(ph,.45);
  vec2 a=aspectUV(v_uv);vec2 ex=extA();
  vec2 pos=ex-vec2(.13,.13)+(hash22(vec2(floor(u_time*24.),u_seed))-.5)*.004;
  vec2 d=a-pos;
  float n=fbm3(d*35.+u_seed*9.);
  float r=.042+(n-.5)*.018;
  float dot_=ss(r,r-.004,length(d));
  float ring=ss(.012,0.,abs(length(d)-r))*.8;
  vec3 c=mix(src,vec3(.05,.03,.02),dot_*on);
  c+=vec3(1.,.9,.7)*ring*on*.6;
  emit(src,c);
}`),

  fx('super8', 'Super 8', 'film', 'Home-movie 8mm: warm faded colour, rounded gate, jitter, grain and light leaks.',
    [A(0.85), P('leak', 'Light Leak', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  float fr=floor(u_time*18.)+u_seed*11.;
  vec2 j=(hash22(vec2(fr,3.))-.5)*vec2(.002,.004);
  vec2 uv=v_uv+j;
  vec3 c=blur6(uv,.0018);
  c=c*.84+.06;
  c*=vec3(1.1,1.,.8);
  c=saturate3(c,.82);
  c=c*c*(3.-2.*c)*.25+c*.75;
  c+=grain(18.)*.12;
  c*=.94+.06*hash11(fr);
  vec2 a=aspectUV(v_uv);vec2 ex=extA();
  float g=sdBox(a,ex*vec2(.96,.94)-.06)-.06;
  c*=ss(.008,-.008,g);
  float lk=vnoise(vec2(u_time*.6,u_seed*5.));
  float leak=smoothstep(.4,.9,lk)*ss(.8,0.,length(a-vec2(ex.x,ex.y*.3)));
  c+=vec3(1.,.42,.12)*leak*u_p.x*.8;
  emit(src,c);
}`),

  fx('tintype', 'Tintype', 'film', 'Haunted 1800s portrait plate: silvery sepia, oval vignette, chemical stains.',
    [A(0.9), P('stain', 'Stains', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);vec2 ex=extA();
  float r=length(a/ex);
  vec3 c=mix(src,blur12(v_uv,.012),smoothstep(.4,1.,r));
  float l=luma(c);l=smoothstep(.05,.95,l);
  vec3 tone=mix(vec3(.07,.06,.05),vec3(.85,.8,.7),l);
  tone+=vec3(.03,.04,.05)*vnoise(a*3.);
  float st=smoothstep(.55,.8,fbm(a*3.+u_seed*13.))*u_p.x;
  tone*=1.-st*.55;
  tone+=vec3(.12,.1,.06)*smoothstep(.7,.9,fbm3(a*7.+3.))*u_p.x;
  tone*=ss(1.15,.55,r);
  tone+=grain(12.)*.05;
  emit(src,tone);
}`),

  // ======================= BLUR & MOTION =======================
  fx('zoom-blur', 'Zoom Blur', 'blur-motion', 'Radial zoom streaks rushing toward a point.',
    [A(0.6), P('x', 'Centre X', 0, 1, 0.5), P('y', 'Centre Y', 0, 1, 0.5)], `
void main(){
  vec2 c=vec2(u_p.x,u_p.y);
  vec2 d=(v_uv-c)*.18*u_amt/16.;
  vec3 acc=vec3(0.);
  for(int i=0;i<16;i++) acc+=tex(v_uv-d*float(i));
  emitc(acc/16.);
}`),

  fx('smear-motion', 'Motion Smear', 'blur-motion', 'Heavy motion blur — movement leaves long dreamy smears.',
    [A(0.6)], `
void main(){
  vec3 src=srcC();
  vec3 p=prevTex(v_uv);
  emit(src,mix(src,p,.82));
}`, { feedback: true }),

  fx('tilt-shift', 'Tilt Shift', 'blur-motion', 'Only a thin band stays sharp — miniature, voyeuristic feel.',
    [A(1), P('center', 'Focus Height', 0, 1, 0.5), P('width', 'Focus Width', 0, 0.5, 0.15)], `
void main(){
  vec3 src=srcC();
  float d=max(abs(v_uv.y-u_p.x)-u_p.y,0.);
  float r=clamp(d*.08,0.,.025)*u_amt;
  vec3 c=blur12(v_uv,r);
  c=saturate3(c,1.+.2*u_amt);
  emitc(c);
}`),

  fx('dream-blur', 'Dream Blur', 'blur-motion', 'Soft hazy glow like a half-remembered nightmare.',
    [A(0.7), P('size', 'Size', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  float pulse=.85+.15*sin(u_time*1.3+u_seed*6.);
  vec3 b=blur12(v_uv,mix(.01,.04,u_p.x)*pulse);
  vec3 c=screenB(src*.8,b*.65);
  c=saturate3(c,.8)*vec3(1.,.98,1.04);
  emit(src,c);
}`),

  fx('double-vision', 'Double Vision', 'blur-motion', 'Concussed, drugged double vision that drifts apart and together.',
    [A(0.7), P('dist', 'Distance', 0, 1, 0.5), P('speed', 'Speed', 0, 3, 0.6)], `
void main(){
  vec2 a=aspectUV(v_uv);
  float s=(.4+.6*(.5+.5*sin(u_time*u_p.y*2.+u_seed*6.)))*.05*u_p.x*u_amt;
  vec3 c1=tex(fromAspect(a+vec2(s,s*.15))),c2=tex(fromAspect(a-vec2(s,s*.15)));
  emitc((c1+c2)*.5);
}`),

  fx('spin-blur', 'Spin Blur', 'blur-motion', 'Rotational blur, like the room is spinning around you.',
    [A(0.6), P('angle', 'Angle', 0, 1, 0.4)], `
void main(){
  vec2 a=aspectUV(v_uv);
  float ang=u_p.x*.25*u_amt;
  vec3 acc=vec3(0.);
  for(int i=0;i<12;i++){float f=float(i)/11.-.5;acc+=tex(fromAspect(rot2(f*ang)*a));}
  emitc(acc/12.);
}`),

  // ======================= FRAMES & MASKS =======================
  fx('vignette', 'Heavy Vignette', 'frame', 'Darkness closes in around the edges.',
    [A(0.8), P('size', 'Size', 0, 1, 0.5), P('soft', 'Softness', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  float r=sqrt(vigE(v_uv));
  float inner=mix(.95,.15,u_p.x);
  float v=1.-smoothstep(inner,inner+mix(.08,.9,u_p.y),r);
  emit(src,src*v);
}`),

  fx('peephole', 'Door Peephole', 'frame', 'Looking through a door peephole: round fisheye view, black around it.',
    [A(1), P('size', 'Size', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);
  float R=mix(.3,.5,u_p.x);
  float r=length(a)/R;
  vec2 s=a*(.6+.55*r*r);
  vec3 c=tex(fromAspect(s));
  vec2 ca=a*.012*r*r;
  c.r=tex(fromAspect(s+ca)).r;c.b=tex(fromAspect(s-ca)).b;
  c*=1.-.65*pow(min(r,1.),4.);
  float mask=ss(1.,.98,r);
  float ring=ss(.98,1.02,r)*ss(1.08,1.02,r);
  vec3 f=c*mask+ring*vec3(.25,.2,.12);
  emit(src,f);
}`),

  fx('binoculars', 'Binoculars', 'frame', 'Two-circle binocular view of something far away.',
    [A(1), P('zoom', 'Zoom', 1, 3, 1.5)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv);vec2 ex=extA();
  float R=min(ex.x*.55,ex.y*.95);
  float sep=R*.75;
  float d=min(length(a-vec2(-sep,0.)),length(a+vec2(-sep,0.)))-R;
  vec3 c=tex(fromAspect(a/u_p.x));
  float m=ss(.01,-.01,d);
  c*=1.-.4*smoothstep(-.12,0.,d);
  emit(src,c*m);
}`),

  fx('keyhole', 'Keyhole', 'frame', 'Spying through an old keyhole.',
    [A(1), P('size', 'Size', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  vec2 a=aspectUV(v_uv)/mix(.6,1.3,u_p.x);
  float circ=length(a-vec2(0.,.08))-.13;
  vec2 q=a-vec2(0.,-.1);
  float w=.05+(-.1-a.y)*.25;
  float trap=max(abs(q.x)-max(w,0.),abs(q.y)-.17);
  float d=min(circ,trap);
  float m=ss(.006,-.006,d);
  vec3 c=src*(1.-.35*smoothstep(-.06,0.,d));
  vec3 door=vec3(.05,.03,.02)*(.7+.3*fbm3(aspectUV(v_uv)*vec2(2.,30.)));
  emit(src,mix(door,c,m));
}`),

  fx('camcorder', 'Camcorder Viewfinder', 'frame', 'Found-footage camcorder overlay: REC dot, timecode, battery, corner brackets.',
    [A(1), P('tint', 'Video Look', 0, 1, 0.4)], `
${strFn('recLbl', 'REC')}
${strFn('spLbl', 'SP')}
void main(){
  vec3 src=srcC();
  vec3 c=src;
  c=mix(c,saturate3(c,.85)*vec3(1.02,1.,.96)+grain(30.)*.05,u_p.x);
  c*=1.-.06*u_p.x*scanl(240.);
  vec2 fc=gl_FragCoord.xy;float m=minres();
  vec2 q=abs(fc-u_res*.5)-(u_res*.5-m*.07);
  float L=m*.085,T=max(1.5,m*.005);
  float br=min(sdBox(q-vec2(-L*.5,-T*.5),vec2(L*.5,T*.5)),sdBox(q-vec2(-T*.5,-L*.5),vec2(T*.5,L*.5)));
  float ui=step(br,0.);
  vec2 cc=fc-u_res*.5;
  ui+=step(sdBox(cc,vec2(m*.025,T*.5)),0.)+step(sdBox(cc,vec2(T*.5,m*.025)),0.);
  float px=max(2.,floor(m*.008));
  vec2 org=vec2(m*.1,u_res.y-m*.1-px*5.);
  float rec=ss(px*2.4,px*1.9,length(fc-org-vec2(px*2.,px*2.5)))*step(.5,fract(u_time*.9));
  ui+=recLbl((fc-org-vec2(px*6.,0.))/px);
  vec2 org2=vec2(u_res.x-m*.1-px*31.,m*.1);
  ui+=drawClock((fc-org2)/px,u_time+floor(u_seed*600.));
  ui+=spLbl((fc-vec2(m*.1,m*.1))/px);
  vec2 bp=(fc-vec2(u_res.x-m*.1-px*16.,u_res.y-m*.1-px*5.))/px;
  float bd=sdBox(bp-vec2(6.,2.5),vec2(6.,2.5));
  ui+=step(abs(bd),.55)+step(sdBox(bp-vec2(13.,2.5),vec2(.8,1.2)),0.);
  ui+=step(sdBox(bp-vec2(2.,2.5),vec2(.9,1.6)),0.)+step(sdBox(bp-vec2(4.6,2.5),vec2(.9,1.6)),0.)+step(sdBox(bp-vec2(7.2,2.5),vec2(.9,1.6)),0.);
  c=mix(c,vec3(.97),clamp(ui,0.,1.)*.9);
  c=mix(c,vec3(1.,.1,.08),rec);
  emit(src,c);
}`),

  fx('crt-tv', 'Old CRT TV', 'frame', 'Curved glass tube TV: scanlines, phosphor mask, glow and dark bezel.',
    [A(1), P('curve', 'Curvature', 0, 1, 0.5), P('lines', 'Scanlines', 0, 1, 0.6)], `
void main(){
  vec3 src=srcC();
  vec2 p=v_uv*2.-1.;
  p+=p*(p.yx*p.yx)*.16*u_p.x;
  vec2 uv=p*.5+.5;
  vec2 a=(uv-.5)*u_res/minres();vec2 ex=extA();
  float rb=sdBox(a,ex-.05)-.05;
  vec3 c=tex(uv);
  vec3 glow=blur6(uv,.01);
  float sl=.5+.5*sin(uv.y*u_res.y/minres()*300.*PI);
  c*=1.-u_p.y*.45*sl;
  float tri=mod(floor(gl_FragCoord.x/pxScale()),3.);
  vec3 mk=vec3(tri<.5?1.:.75,abs(tri-1.)<.5?1.:.75,tri>1.5?1.:.75);
  c*=mix(vec3(1.),mk,.6);
  c=c*1.25+glow*.25;
  c*=1.-.4*smoothstep(.3,1.2,vigE(uv));
  c*=ss(.004,-.004,rb);
  c+=vec3(.02,.025,.03)*ss(-.004,.004,rb);
  emit(src,c);
}`),

  fx('instant-photo', 'Instant Photo Frame', 'frame', 'The scene becomes a faded instant photo in a white frame.',
    [A(1), P('fade', 'Fade', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  float m=minres();
  vec2 fc=gl_FragCoord.xy/m;vec2 W=u_res/m;
  float bS=.055,bB=min(.2,W.y*.14);
  vec2 lo=vec2(bS,bB),hi=W-vec2(bS,bS);
  vec2 sz=hi-lo;
  float sc=max(sz.x/W.x,sz.y/W.y);
  vec2 uv=.5+(fc-(lo+hi)*.5)/(W*sc);
  vec3 ph=tex(uv);
  ph=ph*(1.-.25*u_p.x)+vec3(.09,.07,.05)*u_p.x;
  ph*=vec3(1.04,1.,.9);
  ph=saturate3(ph,1.-.3*u_p.x);
  ph*=1.-.3*smoothstep(.3,1.,vigE(uv));
  float inside=step(lo.x,fc.x)*step(fc.x,hi.x)*step(lo.y,fc.y)*step(fc.y,hi.y);
  vec3 paper=vec3(.93,.92,.88)*(.97+.03*vnoise(fc*80.));
  paper*=1.-.12*ss(.012,0.,min(min(fc.x-lo.x+.012,hi.x-fc.x+.012),min(fc.y-lo.y+.012,hi.y-fc.y+.012)))*(1.-inside);
  emit(src,mix(paper,ph,inside));
}`),

  // ======================= SCARES =======================
  fx('jump-scare', 'Jump Scare Punch', 'scare', 'BANG: zoom punch, flash, negative frames and shake that settle back down.',
    [A(1)], `
void main(){
  vec3 src=srcC();
  float D=lifeD(1.);
  float t=clamp(u_local/D,0.,1.);
  float s=u_local;
  float zin=1.-exp(-s*30.);
  float decay=pow(1.-t,1.6);
  float zoom=1.+.38*zin*decay;
  float shake=decay*.06;
  vec2 o=(hash22(vec2(floor(s*30.),u_seed*7.))-.5)*shake;
  vec2 a=aspectUV(v_uv)/zoom+o;
  vec2 cs=vec2(.018*decay,0.);
  vec3 c=vec3(tex(fromAspect(a+cs)).r,tex(fromAspect(a)).g,tex(fromAspect(a-cs)).b);
  float neg=(s>.05&&s<.1)||(s>.2&&s<.24)?1.:0.;
  c=mix(c,1.-c,neg*step(t,.99));
  float flash=exp(-s*16.);
  c=mix(c,vec3(1.),flash*.9);
  c=(c-.5)*(1.+.5*decay)+.5;
  c*=mix(vec3(1.),vec3(1.25,.8,.8),decay*.6);
  emit(src,c);
}`),

  fx('whiteout', 'Whiteout Flash', 'scare', 'Blinding overexposed white flash that fades back.',
    [A(1)], `
void main(){
  vec3 src=srcC();
  float D=lifeD(.8);float s=u_local;
  float f=smoothstep(0.,.04,s)*exp(-max(s-.04,0.)*4./D);
  vec3 c=src*(1.+5.*f)+f*.6;
  emit(src,mix(c,vec3(1.),smoothstep(.6,1.,f)));
}`),

  fx('blackout', 'Blackout', 'scare', 'Hard cut to darkness for the length of the clip — then snap back.',
    [A(1), P('fade', 'Edge Fade', 0, 0.5, 0.05)], `
void main(){
  vec3 src=srcC();
  float D=u_dur>0.?u_dur:1e6;
  float fd=max(u_p.x,.001);
  float k=smoothstep(0.,fd,u_local)*(1.-smoothstep(D-fd,D,u_local));
  float n=hash13(vec3(floor(gl_FragCoord.xy/pxScale()),floor(u_time*24.)))*.015;
  emit(src,mix(src,vec3(n),k));
}`),

  fx('red-flash', 'Blood Flash', 'scare', 'A hit of blood red that pulses over the frame.',
    [A(1)], `
void main(){
  vec3 src=srcC();
  float D=lifeD(.7);float s=u_local;
  float f=smoothstep(0.,.03,s)*exp(-max(s-.03,0.)*3.5/D);
  float l=luma(src);
  vec3 red=vec3(.6+l*.9,l*.1,l*.08);
  vec3 c=mix(src,red,clamp(f*1.3,0.,1.));
  c*=1.-.5*f*smoothstep(.2,1.,vigE(v_uv));
  emit(src,c);
}`),

  fx('subliminal', 'Subliminal Frame', 'scare', 'Single-frame flashes of a harsh inverted, zoomed image — did you see that?',
    [A(1), P('every', 'Every (sec)', 0.2, 5, 0.8)], `
void main(){
  vec3 src=srcC();
  float per=max(u_p.x,.2);
  float on=step(mod(u_local,per),.06);
  vec2 a=aspectUV(v_uv)/1.35+(hash22(vec2(floor(u_local/per),u_seed))-.5)*.08;
  vec3 c=tex(fromAspect(a));
  float l=luma(c);
  vec3 f=vec3(1.-l);
  f=smoothstep(.25,.75,f)*vec3(1.,.85,.85);
  emit(src,mix(src,f,on));
}`),

  fx('zoom-crash', 'Crash Zoom', 'scare', 'Sudden violent zoom onto a target with a motion-blur whoosh.',
    [A(1), P('zoom', 'Zoom', 1, 3, 1.7), P('x', 'Target X', 0, 1, 0.5), P('y', 'Target Y', 0, 1, 0.55)], `
void main(){
  float s=u_local;
  float g=smoothstep(0.,.14,s);
  float v=g*(1.-g)*4.*u_amt;
  float z=1.+(max(u_p.x,1.)-1.)*g*u_amt;
  vec2 c=vec2(u_p.y,u_p.z);
  vec3 acc=vec3(0.);
  for(int i=0;i<8;i++){
    float zi=z*(1.-v*.2*float(i)/7.);
    acc+=tex(c+(v_uv-c)/max(zi,.01));
  }
  emitc(acc/8.);
}`),

  fx('freeze-stutter', 'Freeze Stutter', 'scare', 'The video catches and freezes in jerky stutters, like the tape is fighting back.',
    [A(1), P('rate', 'Stutters/sec', 1, 20, 8)], `
void main(){
  vec3 src=srcC();
  float k=floor(u_local*u_p.x);
  float h=step(.35,hash11(k+u_seed*13.));
  vec3 p=prevTex(v_uv);
  vec3 c=mix(src,p,h);
  c*=1.-.08*h*step(.5,hash12(vec2(floor(v_uv.y*40.),k)));
  emit(src,c);
}`, { feedback: true }),

  fx('shatter', 'Screen Shatter', 'scare', 'The screen smashes: white impact, cracks race out, shards slip and fall.',
    [A(1), P('x', 'Impact X', 0, 1, 0.5), P('y', 'Impact Y', 0, 1, 0.5)], `
void main(){
  vec3 src=srcC();
  float D=lifeD(1.5);
  float t=clamp(u_local/D,0.,1.);float s=u_local;
  vec2 a=aspectUV(v_uv);vec2 c0=aspectUV(vec2(u_p.x,u_p.y));
  vec2 q=(a-c0)*6.;
  vec2 ip=floor(q),fp=fract(q);
  float f1=8.,f2=8.;vec2 cid=vec2(0.);
  for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){
    vec2 g=vec2(float(i),float(j));vec2 o=hash22(ip+g+u_seed*17.);
    vec2 d=g+o-fp;float dd=dot(d,d);
    if(dd<f1){f2=f1;f1=dd;cid=ip+g;}else if(dd<f2)f2=dd;
  }
  float edge=sqrt(f2)-sqrt(f1);
  float dist=length(a-c0);
  float spread=smoothstep(0.,.25,s*2.)*1.6;
  float crackOn=step(dist,spread);
  float crack=ss(.06,.0,edge)*crackOn;
  vec2 cellC=(cid+.5)/6.;
  vec2 out_=normalize(cellC+1e-3)*.05*t*t;
  vec2 fall=vec2(0.,-.25*t*t*hash12(cid+3.));
  vec2 rotc=rot2((hash12(cid)-.5)*.6*t)*(a-c0-cellC);
  vec2 sa=c0+cellC+rotc-out_-fall;
  vec3 col=tex(fromAspect(sa));
  float gone=step(1.-t*.45,hash12(cid+9.))*step(.35,t);
  col*=1.+(hash12(cid)-.5)*.3*crackOn;
  col=mix(col,vec3(.95),crack*(1.-t*.5));
  col*=1.-gone*.92;
  col*=1.-.35*crackOn*smoothstep(.0,.08,edge)*0.;
  col+=exp(-s*12.)*.9+ss(.12,0.,dist)*exp(-s*3.)*.6;
  emit(src,col);
}`),

  fx('heartbeat', 'Heartbeat', 'scare', 'Lub-dub pulse: the frame thumps and red closes in with every beat.',
    [A(0.8), P('bpm', 'BPM', 40, 180, 80, 1)], `
void main(){
  vec3 src=srcC();
  float ph=fract(u_local*u_p.x/60.);
  float env=exp(-ph*30.)+.7*exp(-max(ph-.18,0.)*30.)*step(.18,ph);
  vec2 a=aspectUV(v_uv)/(1.+.035*env);
  vec3 c=tex(fromAspect(a));
  float v=smoothstep(.15,1.,vigE(v_uv));
  c=mix(c,c*vec3(1.,.2,.15)*.7,v*(.5+.5*env));
  c=saturate3(c,1.-.3*env);
  emit(src,c);
}`),
];

// ---------------------------------------------------------------------------
// TRANSITIONS  (u_side 0 = outgoing clip, u_prog 0..0.5 ; 1 = incoming, 0.5..1)
// ---------------------------------------------------------------------------
const tr = (id, name, desc, dur, glsl) => ({ id, name, desc, dur, glsl });
export const TRANSITIONS = [
  tr('fade-black', 'Fade Through Black', 'Classic dip into darkness and back out.', 0.8, `
void main(){
  vec3 src=srcC();float e=tpeak();e=e*e*(3.-2.*e);
  emitc(src*(1.-e)-e*.05);
}`),
  tr('flash-white', 'White Flash', 'Overexposed blast of light hides the cut.', 0.5, `
void main(){
  vec3 src=srcC();float e=tpeak();
  vec3 c=src*(1.+e*4.)+vec3(e*e);
  emitc(mix(c,vec3(1.),smoothstep(.6,1.,e)));
}`),
  tr('static-burst', 'Static Burst', 'The signal dissolves into TV snow at the cut.', 0.6, `
void main(){
  vec3 src=srcC();float e=tpeak();
  float fr=floor(u_time*30.);
  float n=hash13(vec3(floor(gl_FragCoord.xy/max(1.,minres()/540.)),fr+u_seed*50.));
  float jit=(hash12(vec2(floor(v_uv.y*60.),fr))-.5)*.12*e*e;
  vec3 c=tex(v_uv+vec2(jit,0.));
  c=mix(c,vec3(n),smoothstep(.15,.85,e));
  c*=1.-.2*scanl(200.)*e;
  emitc(c);
}`),
  tr('glitch-tear', 'Glitch Tear', 'Bands rip apart, colours split and the picture drops out.', 0.5, `
void main(){
  vec3 src=srcC();float e=tpeak();
  float fr=floor(u_time*20.)+u_seed*9.;
  float band=floor(v_uv.y*24.);
  float h=hash12(vec2(band,fr));
  float sel=step(1.-e*.9,h);
  vec2 uv=vec2(fract(v_uv.x+(hash12(vec2(band,fr+3.))-.5)*.4*sel*e),v_uv.y);
  vec2 d=vec2(.03*e,0.);
  vec3 c=vec3(tex(uv+d).r,tex(uv).g,tex(uv-d).b);
  float blk=step(1.-e*e*.8,hash13(vec3(floor(v_uv*vec2(12.,20.)),fr)));
  c*=1.-blk;
  emitc(c*(1.-smoothstep(.85,1.,e)));
}`),
  tr('vhs-rewind', 'VHS Rewind', 'Tape rewinds: picture rolls and skews, dissolving into blue screen.', 0.8, `
void main(){
  vec3 src=srcC();float e=tpeak();float e2=e*e;
  float fr=floor(u_time*30.);
  vec2 uv=v_uv;
  uv.y=fract(uv.y+e2*fract(u_time*2.5));
  uv.x+=(uv.y-.5)*e2*.25*sin(u_time*20.)+(hash12(vec2(floor(uv.y*120.),fr))-.5)*.05*e2;
  vec3 c=tex(vec2(fract(uv.x),uv.y));
  float lines=step(1.-e*.25,hash12(vec2(floor(v_uv.y*u_res.y/3.),fr)));
  c=mix(c,vec3(hash12(gl_FragCoord.xy+fr)),lines);
  c=mix(c,saturate3(c,.5)*vec3(.8,.9,1.2),e);
  c=mix(c,vec3(.08,.12,.65),smoothstep(.8,1.,e));
  emitc(c);
}`),
  tr('blood-wipe', 'Blood Wipe', 'Blood pours down over the screen, then slides away to reveal the next shot.', 1.0, `
void main(){
  vec3 src=srcC();float e=tpeak();
  vec2 a=aspectUV(v_uv);
  float x=v_uv.x*u_res.x/minres();
  float drip=(fbm3(vec2(x*5.+u_seed*10.,0.))-.5)*.35+pow(vnoise(vec2(x*26.,u_seed*3.)),3.)*.25;
  float y=v_uv.y;
  float d=u_side<.5?y-(1.5-2.*e)+drip:(2.*e-.5)+drip-y;
  float m=smoothstep(0.,.008,d);
  float sh=fbm3(a*7.+vec2(0.,u_time*.3));
  vec3 blood=vec3(.32,0.,.02)*(.6+.6*sh)+vec3(.5,.15,.12)*pow(smoothstep(.55,.8,sh),2.);
  blood*=1.-.5*ss(.05,0.,d);
  vec3 c=mix(src,blood,m);
  emitc(c);
}`),
  tr('eye-blink', 'Eye Blink', 'Heavy eyelids close, the world goes dark and blurry, then blinks open.', 0.8, `
void main(){
  vec3 src=srcC();float e=tpeak();float c=smoothstep(0.,1.,e);
  vec2 a=aspectUV(v_uv);vec2 ex=extA();
  float open=(1.-c)*ex.y*2.2;
  float lid=open*(1.-.5*pow(a.x/ex.x,2.));
  float d=abs(a.y)-lid;
  float m=smoothstep(-.02,.02,d);
  vec3 img=blur12(v_uv,.025*c)*(1.-.5*c);
  vec3 skin=vec3(.04,.01,.01)+vec3(.35,.05,.03)*ss(.1,0.,d)*(1.-c*.5);
  emitc(mix(img,skin,m));
}`),
  tr('film-burn', 'Film Burn', 'The film melts and burns through to white-hot light.', 0.9, `
void main(){
  vec3 src=srcC();float e=tpeak();
  vec2 a=aspectUV(v_uv);
  float n=fbm(a*2.2+u_seed*7.+vec2(0.,u_time*.3));
  float f=n*.6+length(a-vec2(.15,-.1))*.6;
  float d=f-(e*1.5-.1);
  vec3 c=mix(src,src*vec3(1.4,1.,.6)+.08,e);
  c=mix(c,vec3(1.,.5,.12)*1.4,ss(.12,0.,d));
  c=mix(c,vec3(1.,.97,.9),ss(0.,-.06,d));
  emitc(c);
}`),
  tr('zoom-punch', 'Zoom Punch', 'Radial blur punch-in that blasts into the next shot.', 0.5, `
void main(){
  float e=tpeak();float s=e*e;
  vec2 a=aspectUV(v_uv)/(1.+s*.6);
  vec3 acc=vec3(0.);
  for(int i=0;i<12;i++){float f=float(i)/11.;acc+=tex(fromAspect(a*(1.-f*.3*s)));}
  acc/=12.;
  emitc(acc+vec3(s*s*.7));
}`),
  tr('pixel-dissolve', 'Pixel Dissolve', 'The image breaks into chunky pixels that blink out to black.', 0.7, `
void main(){
  float e=tpeak();
  float bs=floor(1.+e*e*40.*max(1.,minres()/540.));
  vec2 cell=floor(gl_FragCoord.xy/bs);
  vec3 c=tex((cell+.5)*bs/u_res);
  float h=hash12(cell+u_seed*11.+bs*.1);
  float off=step(h,smoothstep(.3,1.,e)*1.02-.01);
  emitc(c*(1.-off));
}`),
  tr('tv-off-on', 'TV Power Off/On', 'Old CRT switches off to a glowing line and dot, then powers back on.', 0.7, `
void main(){
  float e=tpeak();
  vec2 a=aspectUV(v_uv);vec2 ex=extA();
  float sy=1.-smoothstep(0.,.55,e)*.995;
  float sx=1.-smoothstep(.55,.9,e)*.99;
  vec2 s=a/vec2(sx,sy);
  float inside=step(abs(s.x),ex.x)*step(abs(s.y),ex.y);
  vec3 c=tex(fromAspect(s))*inside;
  float br=smoothstep(.2,.6,e);
  c=c*(1.+br*3.)+br*.3*inside;
  c=mix(c,vec3(inside),smoothstep(.4,.6,e));
  c+=vec3(.6,.7,1.)*exp(-abs(a.y)/(.003+.4*sy))*exp(-abs(a.x)/(.01+ex.x*sx))*smoothstep(.3,.6,e)*(1.-smoothstep(.9,1.,e));
  c*=1.-smoothstep(.92,1.,e);
  emitc(c);
}`),
  tr('shadow-sweep', 'Shadow Sweep', 'A wall of living shadow sweeps across the frame.', 0.9, `
void main(){
  vec3 src=srcC();float e=tpeak();e=smoothstep(0.,1.,e);
  vec2 a=aspectUV(v_uv);vec2 ex=extA();
  float n=fbm(a*3.+vec2(u_time*.3,u_seed*5.))-.5;
  float x=a.x/ex.x*.5+.5;
  float d=u_side<.5?(-.35+1.7*e)+n*.3-x:x+n*.3-(1.35-1.7*e);
  float m=smoothstep(-.06,.06,d);
  vec3 c=src*(1.-m)+vec3(.12,0.,.18)*ss(.15,0.,abs(d))*(1.-m);
  emitc(c);
}`),
  tr('ink-bleed', 'Ink Bleed', 'Black ink blots spread and swallow the picture.', 0.9, `
void main(){
  vec3 src=srcC();float e=tpeak();
  vec2 a=aspectUV(v_uv);
  float f=fbm(a*3.+u_seed*9.)*.7+vnoise(a*1.5+u_seed*3.)*.3;
  float d=f+e*1.3-1.15;
  float m=smoothstep(0.,.03,d);
  vec3 c=src*(1.-.3*ss(.15,0.,-d));
  emitc(mix(c,vec3(.02,0.,.03),m));
}`),
  tr('lightning-cut', 'Lightning Cut', 'A crackling lightning flash covers the cut.', 0.5, `
void main(){
  vec3 src=srcC();float e=tpeak();
  float fl=e*(.65+.35*step(.5,hash11(floor(u_time*24.)+u_seed)));
  vec3 c=mix(src,pow(src,vec3(.5))*vec3(.85,.9,1.2)*1.8+.2,fl);
  emitc(mix(c,vec3(.9,.95,1.),smoothstep(.75,1.,e)));
}`),
  tr('swirl-dip', 'Swirl Into Darkness', 'The picture twists into a whirlpool and drains into black.', 0.8, `
void main(){
  float e=tpeak();float s=e*e*(3.-2.*e);
  vec2 a=aspectUV(v_uv);float r=length(a);
  a=rot2(s*7.*ss(1.,0.,r))*a*(1.+s*.6);
  vec3 c=tex(fromAspect(a));
  c*=1.-smoothstep(.35,1.,s)*(.6+.4*smoothstep(0.,.6,r));
  emitc(c*(1.-smoothstep(.8,1.,s)));
}`),
  tr('shake-cut', 'Shake Cut', 'Violent camera jolt with motion blur hides the cut.', 0.5, `
void main(){
  float e=tpeak();
  vec2 o=(hash22(vec2(floor(u_time*30.),u_seed*9.))-.5)*.14*e;
  vec2 a=aspectUV(v_uv)/(1.+.15*e)+o;
  vec3 c=vec3(0.);
  for(int i=0;i<6;i++){c+=tex(fromAspect(a+o*float(i)*.12));}
  c/=6.;
  emitc(c*(1.-.85*smoothstep(.6,1.,e)));
}`),
];

// ---------------------------------------------------------------------------
// LOOKS (preset stacks)
// ---------------------------------------------------------------------------
const L = (type, params) => ({ type, params });
export const LOOKS = [
  { id: 'night-vision-camcorder', name: 'Night Vision Camcorder', desc: 'Green IR camcorder with REC overlay, the classic bedroom-at-3am shot.',
    effects: [L('night-vision', { amt: 0.95, gain: 2, noise: 0.55, bloom: 0.7 }), L('handheld-shake', { amt: 0.2, speed: 0.8, roll: 0.4 }), L('camcorder', { amt: 1, tint: 0 })] },
  { id: 'security-cam', name: 'Security Cam', desc: 'Fisheye CCTV corner camera with timestamp and choppy frames.',
    effects: [L('cctv-fisheye', { amt: 0.5 }), L('film-grain', { amt: 0.4, size: 0.3, color: 0 }), L('security-cam', { amt: 1, choppy: 0.45, noise: 0.5, osd: 1 })] },
  { id: 'vhs-found-footage', name: 'VHS Found Footage', desc: 'A tape found in the woods: VHS smear, tracking glitches and a shaky hand.',
    effects: [L('vhs', { amt: 0.9, wobble: 0.6, noise: 0.6, bleed: 0.7 }), L('tracking-error', { amt: 0.5, speed: 0.25, size: 0.4 }), L('handheld-shake', { amt: 0.25, speed: 1, roll: 0.5 }), L('vignette', { amt: 0.5, size: 0.4, soft: 0.6 })] },
  { id: 'grindhouse-16mm', name: '16mm Grindhouse', desc: 'Beaten-up exploitation print: scratches, weave, halation and grain.',
    effects: [L('bleach-bypass', { amt: 0.5 }), L('halation', { amt: 0.6, thresh: 0.55 }), L('old-projector', { amt: 0.8, weave: 0.6, flicker: 0.5 }), L('scratches-dust', { amt: 0.85, dust: 0.6 }), L('film-grain', { amt: 0.7, size: 0.6, color: 0.25 }), L('cigarette-burns', { amt: 1, every: 6 })] },
  { id: 'cursed-tape', name: 'Cursed Tape', desc: 'The tape that should not be watched: green-cyan murk, interference and flashes.',
    effects: [L('sick-green', { amt: 0.6 }), L('desaturate', { amt: 0.5, contrast: 1.3 }), L('vhs', { amt: 0.8, wobble: 0.7, noise: 0.7, bleed: 0.5 }), L('signal-tear', { amt: 0.35, bands: 0.4 }), L('subliminal', { amt: 1, every: 2.3 }), L('crt-tv', { amt: 1, curve: 0.5, lines: 0.5 })] },
  { id: 'thermal-hunt', name: 'Thermal Hunt', desc: 'Stalking the house in heat vision.',
    effects: [L('heat-hunter', { amt: 1, soft: 0.45, shift: 0, noise: 0.5 }), L('handheld-shake', { amt: 0.25, speed: 0.7, roll: 0.3 }), L('vignette', { amt: 0.5, size: 0.4, soft: 0.6 })] },
  { id: 'possessed', name: 'Possessed', desc: 'Something has taken over: red twitching frame, glowing eyes, heartbeat.',
    effects: [L('possessed', { amt: 0.85, rate: 0.5 }), L('demon-glow', { amt: 0.5, thresh: 0.7 }), L('heartbeat', { amt: 0.6, bpm: 110 }), L('film-grain', { amt: 0.5, size: 0.4, color: 0.2 })] },
  { id: 'ghost-hunt', name: 'Ghost Hunt', desc: 'Paranormal investigation: full-spectrum cam, orbs, spirit-box readout.',
    effects: [L('full-spectrum', { amt: 0.85, glow: 0.6 }), L('orbs', { amt: 0.8, density: 0.5, speed: 0.4, size: 0.5 }), L('spirit-box', { amt: 0.85, static: 0.5 }), L('handheld-shake', { amt: 0.2, speed: 1, roll: 0.4 })] },
  { id: 'blood-moon', name: 'Blood Moon', desc: 'Red night sky grade with deep shadows and a halo of glow.',
    effects: [L('duotone', { amt: 0.75, dark: 0.98, light: 0.03, contrast: 1.3 }), L('crush', { amt: 0.6, crush: 0.4 }), L('bloom', { amt: 0.5, thresh: 0.55, size: 0.6 }), L('vignette', { amt: 0.8, size: 0.55, soft: 0.6 })] },
  { id: 'foghaven', name: 'Foghaven', desc: 'A town lost in grey fog and falling ash.',
    effects: [L('desaturate', { amt: 0.6, contrast: 0.9 }), L('dense-fog', { amt: 0.85, density: 0.65, speed: 0.2 }), L('ash-fall', { amt: 0.8, density: 0.45, speed: 0.3, size: 0.5 }), L('film-grain', { amt: 0.5, size: 0.5, color: 0 })] },
  { id: 'well-tape', name: 'The Well Tape', desc: 'Murky cyan-green cursed video on an old TV with drifting static.',
    effects: [L('duotone', { amt: 0.85, dark: 0.5, light: 0.4, contrast: 1.15 }), L('tv-static', { amt: 0.2, roll: 0.8 }), L('vhs', { amt: 0.6, wobble: 0.5, noise: 0.5, bleed: 0.4 }), L('crt-tv', { amt: 1, curve: 0.6, lines: 0.7 })] },
  { id: 'witching-hour', name: 'Witching Hour', desc: 'Cold moonlit blue at 3 a.m. with flickering lights.',
    effects: [L('witching-blue', { amt: 0.9 }), L('crush', { amt: 0.5, crush: 0.4 }), L('flicker-lights', { amt: 0.4, speed: 0.6 }), L('film-grain', { amt: 0.45, size: 0.4, color: 0.1 })] },
  { id: 'old-daguerreotype', name: 'Old Daguerreotype', desc: 'A haunted 1800s photograph that moves.',
    effects: [L('tintype', { amt: 0.95, stain: 0.6 }), L('old-projector', { amt: 0.6, weave: 0.3, flicker: 0.6 }), L('scratches-dust', { amt: 0.6, dust: 0.5 })] },
  { id: 'polaroid-nightmare', name: 'Polaroid Nightmare', desc: 'A faded instant photo where something is standing in the background.',
    effects: [L('sepia', { amt: 0.35, fade: 0.4 }), L('apparition', { amt: 0.7, x: 0.72, size: 0.6, flicker: 0.3 }), L('film-grain', { amt: 0.4, size: 0.5, color: 0.3 }), L('instant-photo', { amt: 1, fade: 0.6 })] },
  { id: 'demon-at-the-door', name: 'Demon At The Door', desc: 'Peeking through the peephole while eyes glow in the hallway.',
    effects: [L('crush', { amt: 0.7, crush: 0.6 }), L('lurking-eyes', { amt: 1, x: 0.5, y: 0.58, size: 0.3, hue: 0.02 }), L('peephole', { amt: 1, size: 0.5 })] },
  { id: 'flashlight-search', name: 'Flashlight Search', desc: 'Pitch-black basement, only your flashlight and shaking hands.',
    effects: [L('flashlight', { amt: 1, size: 0.35, soft: 0.5, wander: 0.5 }), L('handheld-shake', { amt: 0.35, speed: 1.2, roll: 0.5 }), L('film-grain', { amt: 0.5, size: 0.4, color: 0.2 })] },
  { id: 'super8-home-movie', name: 'Haunted Home Movie', desc: 'Grandpa\'s old Super 8 reel, with something in the corner of the room.',
    effects: [L('super8', { amt: 0.9, leak: 0.6 }), L('ghost-double', { amt: 0.35, drift: 0.5, speed: 0.3 }), L('scratches-dust', { amt: 0.5, dust: 0.4 })] },
];

// ---------------------------------------------------------------------------
// lookups & params
// ---------------------------------------------------------------------------
const byId = (arr) => { const m = new Map(arr.map((d) => [d.id, d])); return (id) => m.get(id) || null; };
export const effectById = byId(EFFECTS);
export const transitionById = byId(TRANSITIONS);
export const lookById = byId(LOOKS);

export function defaultParams(def) {
  const out = { amt: 1 };
  for (const p of (def && def.params) || []) out[p.k] = p.def;
  return out;
}

export function packParams(def, values) {
  const v = values || {};
  const params = (def && def.params) || [];
  const amtDef = params.find((p) => p.k === 'amt');
  const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  const amt = Math.min(1, Math.max(0, num(v.amt, amtDef ? amtDef.def : 1)));
  const p = [0, 0, 0, 0];
  let i = 0;
  for (const prm of params) {
    if (prm.k === 'amt') continue;
    if (i > 3) break;
    p[i++] = num(v[prm.k], prm.def);
  }
  return { amt, p };
}
