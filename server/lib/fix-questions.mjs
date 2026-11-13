// Explicit question blocks keep code snippets and ordinary log output out of the review conversation.
export function parseFixQuestions({text,threadIds,nonce}) {
 if(!nonce)return[];
 const known=new Set(threadIds),code=String(nonce).replace(/[^0-9a-zA-Z]/g,'');
 const pattern=new RegExp(`@@QUESTION:(thr_[0-9a-f]+):${code}@@[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*@@END:${code}@@`,'g');
 return [...String(text||'').matchAll(pattern)].filter(match=>known.has(match[1])&&match[2].trim()).map(match=>({threadId:match[1],body:match[2].trim()}));
}
