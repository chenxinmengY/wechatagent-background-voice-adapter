// Ephemeral capabilities for one private browsing turn; never used for chat.
export class ReadingCancellation {
  constructor(){this.items=new Map();}
  register(key,batch,token){
    if(!/^wechat:private:[^:]+$/.test(key)||!/^[a-f0-9]{64}$/.test(batch)||!/^[a-f0-9]{64}$/.test(token))throw Error('invalid_reading_request');
    this.prune();if(this.items.size>=128)throw Error('reading_capacity');
    if(this.items.has(token))throw Error('reading_token_in_use');
    const item={key,batch,controller:new AbortController(),claimed:false,createdAt:Date.now()};this.items.set(token,item);
    return item;
  }
  find(key,batch,token){const item=this.items.get(token);return item&&item.key===key&&item.batch===batch?item:null;}
  claim(key,batch,token){const item=this.find(key,batch,token);if(!item||item.claimed)throw Error('reading_token_invalid');item.controller.signal.throwIfAborted();item.claimed=true;return item;}
  cancel(key,batch,token){const item=this.find(key,batch,token);if(!item)return false;item.controller.abort(new Error('reading_interrupted'));return true;}
  release(key,batch,token,{claimed=false}={}){const item=this.find(key,batch,token);if(!item||item.claimed&&!claimed)return false;this.items.delete(token);return true;}
  prune(now=Date.now()){for(const [token,item] of this.items)if(!item.claimed&&now-item.createdAt>120000)this.items.delete(token);}
}
