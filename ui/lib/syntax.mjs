const languages={js:'javascript',jsx:'javascript',mjs:'javascript',cjs:'javascript',ts:'javascript',tsx:'javascript',json:'json',jsonc:'json',kt:'kotlin',kts:'kotlin',groovy:'clike',gradle:'clike',yml:'yaml',yaml:'yaml',py:'python',rs:'clike',go:'clike',java:'clike',c:'clike',h:'clike',cpp:'clike',hpp:'clike',cs:'clike',sh:'shell',bash:'shell',zsh:'shell',sql:'sql'};
const keywords=new Set(('async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let match namespace new null of package private protected public return static struct super switch this throw true try type typeof undefined var void while with yield fn impl mut pub trait use mod self Self def elif except False None True and as assert del global is lambda nonlocal not or pass raise elif with bool boolean int float double char string String auto unsigned long short signed volatile sizeof final abstract override defer func range select chan map make switch then fi done esac echo local readonly declare BEGIN END SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER ON AS INSERT INTO UPDATE SET DELETE CREATE TABLE VALUES GROUP BY ORDER HAVING LIMIT DISTINCT AND OR NOT NULL TRUE FALSE').split(/\s+/u));
export function syntaxLanguage(filename){const name=filename?.split('/').at(-1)||'';return languages[name.split('.').at(-1)?.toLowerCase()]||(['.bashrc','.zshrc'].includes(name)?'shell':null);}
const kotlinKeywords=new Set(('as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where actual abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg value').split(' '));
const codeLanguages=new Set(['javascript','clike','kotlin']);
const identifier=/^[\p{L}_$][\p{L}\p{N}_$]*/u;
export function tokenizeSourceLine(text,language,state=''){
 if(!language||text.length>8192)return{tokens:[{text}],state:''};
 const tokens=[];let index=0;
 const emit=(type,end)=>{if(end>index){const value=text.slice(index,end);if(tokens.length&&tokens.at(-1).type===type)tokens[tokens.length-1].text+=value;else tokens.push({type,text:value});}index=end;};
 function blockComment(cursor,depth){
  while(cursor<text.length&&depth){
   if(language==='kotlin'&&text.startsWith('/*',cursor)){depth++;cursor+=2;}
   else if(text.startsWith('*/',cursor)){depth--;cursor+=2;}
   else cursor++;
  }
  state=depth?(language==='kotlin'?'comment:'+depth:'comment'):'';emit('comment',cursor);
 }
 while(index<text.length){
  if(state==='comment'||/^comment:\d+$/u.test(state)){blockComment(index,state==='comment'?1:Number(state.slice(8)));continue;}
  if(state){
   const delimiter=state;let end;
   if(delimiter==='`'){end=index;while(end<text.length){if(text[end]==='\\'){end+=2;continue;}if(text[end++]==='`'){state='';break;}}end=Math.min(end,text.length);}
   else{end=text.indexOf(delimiter,index);if(end<0)end=text.length;else{end+=delimiter.length;state='';}}
   emit('string',end);continue;
  }
  if((['python','shell','yaml'].includes(language)&&text[index]==='#')||(language==='sql'&&text.startsWith('--',index))||((codeLanguages.has(language)||language==='json')&&text.startsWith('//',index))){emit('comment',text.length);break;}
  if((codeLanguages.has(language)||language==='json'||language==='sql')&&text.startsWith('/*',index)){blockComment(index+2,1);continue;}
  if((['python','kotlin','clike'].includes(language)&&text.startsWith('"""',index))||(language==='python'&&text.startsWith("'''",index))){
   const delimiter=text.slice(index,index+3),end=text.indexOf(delimiter,index+3);if(end<0){state=delimiter;emit('string',text.length);}else emit('string',end+3);continue;
  }
  if(language==='kotlin'&&text[index]==='`'){const end=text.indexOf('`',index+1);emit('variable',end<0?text.length:end+1);continue;}
  if(['"',"'",'`'].includes(text[index])){
   const quote=text[index];let end=index+1,closed=false;
   while(end<text.length){if(text[end]==='\\'){end=Math.min(text.length,end+2);continue;}if(text[end++]===quote){closed=true;break;}}
   if(!closed&&quote==='`'&&language==='javascript')state='`';emit('string',end);continue;
  }
  const rest=text.slice(index);let match=rest.match(/^\s+/u);if(match){emit(undefined,index+match[0].length);continue;}
  if(codeLanguages.has(language)&&text[index]==='@'){
   match=rest.match(/^@[\p{L}_$][\p{L}\p{N}_$]*(?::[\p{L}_$][\p{L}\p{N}_$]*)?(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*/u);
   if(match){emit('annotation',index+match[0].length);continue;}
  }
  match=rest.match(/^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?)(?:[uU](?:[lL])?|[lLfFdD])?/u);if(match){emit('number',index+match[0].length);continue;}
  match=rest.match(identifier);
  if(match){
   const word=match[0],tail=text.slice(index+word.length);let type;
   if((language==='kotlin'||language==='json'||language==='yaml')&&['true','false','null'].includes(word))type='constant';
   else if((language==='kotlin'?kotlinKeywords:keywords).has(word))type='keyword';
   else if(language==='yaml'&&/^\s*:/u.test(tail))type='property';
   else if(codeLanguages.has(language)||language==='python'){
    if(/^[A-Z][A-Z0-9_]+$/u.test(word))type='constant';
    else if(/^[A-Z]/u.test(word))type='type';
    else if(/^(?:<[^<>\n]*>\s*)?\(/u.test(tail.trimStart()))type='function';
    else type='variable';
   }
   emit(type,index+word.length);continue;
  }
  emit(undefined,index+1);
 }
 return{tokens,state};
}

function fileName(line){let name=line.slice(4).split('\t')[0];if(name[0]==='"'){try{name=JSON.parse(name);}catch{return null;}}return name==='/dev/null'?null:name.replace(/^[ab]\//u,'');}
// Hunk gaps have unknown preceding lexical state, so reset there. Old and new
// sides advance independently; deletion-only comments cannot affect additions.
export function highlightDiff(text){
 if(typeof text!=='string'||text.length>2*1024*1024)return new Map();const result=new Map();let oldLanguage=null,newLanguage=null,oldState='',newState='',hunk=null;
 for(const [index,line]of text.split('\n').entries()){
  if(hunk&&(line[0]===' '&&hunk.old>0&&hunk.new>0||line[0]==='-'&&hunk.old>0||line[0]==='+'&&hunk.new>0)){const side=line[0],code=line.slice(1);if(!oldLanguage&&!newLanguage){if(side!=='-')hunk.new--;if(side!=='+')hunk.old--;continue;}if(side==='-'){const value=tokenizeSourceLine(code,oldLanguage,oldState);oldState=value.state;result.set(index,{prefix:side,tokens:value.tokens});hunk.old--;}else if(side==='+'){const value=tokenizeSourceLine(code,newLanguage,newState);newState=value.state;result.set(index,{prefix:side,tokens:value.tokens});hunk.new--;}else{const before=tokenizeSourceLine(code,oldLanguage,oldState),after=tokenizeSourceLine(code,newLanguage,newState);oldState=before.state;newState=after.state;result.set(index,{prefix:side,tokens:after.tokens});hunk.old--;hunk.new--;}continue;}
  if(line.startsWith('diff ')){oldLanguage=null;newLanguage=null;hunk=null;}else if(line.startsWith('--- '))oldLanguage=syntaxLanguage(fileName(line));else if(line.startsWith('+++ '))newLanguage=syntaxLanguage(fileName(line));else if(line.startsWith('@@ ')){const match=/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u.exec(line);oldState='';newState='';hunk=match?{old:Number(match[1]??1),new:Number(match[2]??1)}:null;}
 }
 return result;
}
