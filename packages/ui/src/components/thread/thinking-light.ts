const VERTEX = `#version 300 es
const vec2 P[6]=vec2[6](vec2(-1,-1),vec2(1,-1),vec2(-1,1),vec2(-1,1),vec2(1,-1),vec2(1,1));
void main(){gl_Position=vec4(P[gl_VertexID],0,1);}`;

const FRAGMENT = `#version 300 es
precision highp float;
out vec4 o;
uniform vec2 uSize;        // CSS px
uniform float uDpr;
uniform float uThumb;      // thumb centre, CSS px
uniform float uThumbR;     // thumb radius, CSS px
uniform float uLevel;      // brightness of the current position, 0 = off, 1 = rightmost
uniform float uRows, uGain, uFace, uBleed, uRadius, uMotion, uGrain;
uniform float uFlow;       // accumulated flow distance; it runs faster at higher levels
uniform vec2 uWave;        // x = origin (CSS px), y = seconds since the thumb settled on a new level
uniform vec3 uPlate, uSeam, uLight;

float hash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);}
float sdBox(vec2 p,vec2 b,float r){vec2 q=abs(p)-b+r;return length(max(q,0.))+min(max(q.x,q.y),0.)-r;}

// Light stops at the thumb; the fade sits under the thumb so nothing shows to its right.
float lit(float x){return 1.-smoothstep(uThumb,uThumb+uThumbR*.6,x);}

// A continuous surge of extra light flows left on top of the steady light. It only ever adds, so the base light
// never shows moving dark holes. Low levels flow slow and smooth; higher levels add a faster, finer layer and let the
// streamlines twist until it reads as rapids.
float surge(vec2 c,float cell){
  float turb=smoothstep(.25,1.,uLevel);
  vec2 q=c/cell;
  q.y+=(noise(vec2(q.x*.3+uFlow*.45,q.y*.6+5.))-.5)*mix(.4,1.6,turb);
  float slow=noise(vec2((q.x+uFlow)/3.4,q.y/.8));
  float fast=noise(vec2((q.x+uFlow*1.8)/1.3,q.y/.45+9.));
  float f=mix(slow,slow*.5+fast*.5,turb);
  return pow(smoothstep(.4,.95,f),1.5)*mix(.6,1.6,turb);
}

float field(vec2 c,float cell){
  // The steady light is a little uneven but does not move; only the surge moves.
  float pool=mix(.3,.6,smoothstep(.2,.8,noise(c/(cell*2.6)+11.)));
  float front=lit(c.x);
  float behind=max(uThumb-c.x,0.);
  float right=exp(-behind/(uSize.x*mix(.14,.34,uLevel)));
  float bottom=exp(-(uSize.y-c.y)/(uSize.y*.3));
  return uLevel*front*pool*(.75*right+.6*bottom*mix(.3,1.,right));
}

void main(){
  vec2 S=uSize*uDpr;
  vec2 p=vec2(gl_FragCoord.x,S.y-gl_FragCoord.y);
  float sd=sdBox(p-S*.5,S*.5,uRadius*uDpr);
  float alpha=clamp(.5-sd,0.,1.);
  if(alpha<=0.){o=vec4(0);return;}
  float cell=uSize.y/uRows;
  float cols=max(1.,floor(uSize.x/cell+.5));
  // Seams sit on whole device pixels so every one is equally crisp.
  float i=floor(p.x*cols/S.x+.5), j=floor(p.y*uRows/S.y+.5);
  vec2 J=vec2(floor(i*S.x/cols)+.5,floor(j*S.y/uRows)+.5);
  float dv=(i<.5||i>cols-.5)?1e3:abs(p.x-J.x);
  float dh=(j<.5||j>uRows-.5)?1e3:abs(p.y-J.y);
  float depth=-sd;
  float cv=clamp(1.-dv,0.,1.), ch=clamp(1.-dh,0.,1.), cp=clamp(1.5-depth,0.,1.);
  float seam=max(cv,max(ch,cp));
  // The outer edge is a seam too, but it lets through less light than the seams between plates.
  float dRim=max(depth-.75,0.);
  bool rim=dRim<min(dv,dh);
  vec2 id=vec2(floor(p.x*cols/S.x),floor(p.y*uRows/S.y));
  vec2 c=p/uDpr;
  float L=field(c,cell);

  // Corners where four plates meet let a little more light through.
  float junction=exp(-(dv*dv+dh*dh)/(2.*pow(.9*uDpr,2.)));
  // Settling on a new level sends one ring of light left from the thumb, like the workbench lattice wave.
  float ring=uMotion*lit(c.x)*exp(-pow((abs(c.x-uWave.x)-uWave.y*620.)/(cell*.9),2.))*exp(-uWave.y/.45);
  float Ls=(L*(1.+surge(c,cell))*(1.+.9*junction)*(1.+1.4*ring)+ring*.25*step(.001,uLevel))*(rim?.45:1.);
  float gs=1.-exp(-Ls*2.4*uGain);

  vec3 plate=uPlate*(1.+(hash(id+5.)-.5)*uGrain);
  // Plates take a faint wash from the light beneath; the brightest seams spread a little onto their edges.
  plate=mix(plate,uLight,(1.-exp(-L*2.4*uGain))*uFace);
  float e=max(min(min(dv,dh),dRim)-.5,0.);
  plate=mix(plate,uLight,gs*uBleed*exp(-e/(uDpr*(.3+1.1*gs*gs))));
  plate=mix(plate,uLight,gs*gs*gs*.22*uBleed*exp(-e/(2.4*uDpr)));
  vec3 col=mix(plate,mix(uSeam,uLight,gs),seam);

  o=vec4(col*alpha,alpha);
}`;

/** One GPU surface per open picker. A missing/lost context leaves the CSS track visible. */
export function createThinkingLight(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true, depth: false, powerPreference: 'low-power' });
  if (!gl) return null;
  const program = gl.createProgram();
  const shaders: WebGLShader[] = [];
  function dispose() {
    if (program) gl!.deleteProgram(program);
    for (const shader of shaders) gl!.deleteShader(shader);
    if (!gl!.isContextLost()) gl!.getExtension('WEBGL_lose_context')?.loseContext();
  }
  if (!program) { dispose(); return null; }
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
    const shader = gl.createShader(type);
    if (!shader) { dispose(); return null; }
    shaders.push(shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { dispose(); return null; }
  gl.useProgram(program);
  const u = Object.fromEntries(['uSize','uDpr','uThumb','uThumbR','uLevel','uRows','uGain','uFace','uBleed','uRadius',
    'uMotion','uGrain','uFlow','uWave','uPlate','uSeam','uLight'].map(name => [name, gl.getUniformLocation(program, name)]));
  gl.uniform1f(u.uRows, 3);
  gl.uniform1f(u.uGain, 1.7);
  // Resolve the same CSS paints as the fallback grid, only when the theme changes.
  const colors = [[u.uPlate, 'plate'], [u.uSeam, 'seam'], [u.uLight, 'light']] as const;
  const swatch = canvas.ownerDocument.createElement('canvas');
  swatch.width = colors.length; swatch.height = 1;
  const paint = swatch.getContext('2d', { willReadFrequently: true });
  if (!paint) { dispose(); return null; }
  return {
    palette(style: CSSStyleDeclaration) {
      colors.forEach(([, color], i) => {
        paint.fillStyle = style.getPropertyValue('--thinking-' + color).trim();
        paint.fillRect(i, 0, 1, 1);
      });
      const rgb = paint.getImageData(0, 0, colors.length, 1).data;
      colors.forEach(([uniform], i) => {
        const offset = i * 4;
        gl.uniform3f(uniform, rgb[offset]! / 255, rgb[offset + 1]! / 255, rgb[offset + 2]! / 255);
      });
      const glow = Number(style.getPropertyValue('--thinking-glow'));
      gl.uniform1f(u.uFace, .1 * glow);
      gl.uniform1f(u.uBleed, .5 * glow);
      gl.uniform1f(u.uGrain, Number(style.getPropertyValue('--thinking-grain')));
    },
    resize(width: number, height: number) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(u.uSize, canvas.width / dpr, canvas.height / dpr);
      gl.uniform1f(u.uDpr, dpr);
      gl.uniform1f(u.uRadius, height / 2);
      gl.uniform1f(u.uThumbR, height / 2);
    },
    draw(x: number, level: number, flow: number, motion: boolean, waveX: number, waveAge: number) {
      gl.uniform1f(u.uThumb, x); gl.uniform1f(u.uLevel, level);
      gl.uniform1f(u.uFlow, flow); gl.uniform1f(u.uMotion, Number(motion));
      gl.uniform2f(u.uWave, waveX, waveAge);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    dispose,
  };
}
