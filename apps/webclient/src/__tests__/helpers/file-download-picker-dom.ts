/** Small DOM fixture for the picker; production mounts and event handlers run unchanged. */
export class PickerElement {
  children:PickerElement[]=[];attrs=new Map<string,string>();ownText='';value='';type='';name='';id='';htmlFor='';className='';disabled=false;checked=false;focused=false;open=false;
  listeners=new Map<string,((event:{key?:string;preventDefault():void})=>void)[]>();
  get textContent():string{return this.ownText+this.children.map(c=>c.textContent).join(' ');}
  set textContent(value:string|null){this.ownText=value??'';this.children=[];}
  get firstChild():PickerElement|null{return this.children[0]??null;}
  appendChild(child:PickerElement):PickerElement{this.children.push(child);return child;}
  removeChild(child:PickerElement):PickerElement{this.children=this.children.filter(c=>c!==child);return child;}
  setAttribute(name:string,value:string):void{this.attrs.set(name,value);}
  getAttribute(name:string):string|null{return this.attrs.get(name)??null;}
  addEventListener(type:string,listener:(event:{key?:string;preventDefault():void})=>void):void{this.listeners.set(type,[...this.listeners.get(type)??[],listener]);}
  fire(type:string,key?:string):void{for(const listener of this.listeners.get(type)??[])listener({...(key?{key}:{}),preventDefault(){}});}
  click():void{if(!this.disabled)this.fire('click');}
  focus():void{this.focused=true;}
  contains(node:unknown):boolean{return node===this||this.children.some(child=>child.contains(node));}
  querySelectorAll(selector:string):PickerElement[]{
    const found:PickerElement[]=[];const match=selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    for(const child of this.children){if(match&&child.attrs.has(match[1]!)&&(match[2]===undefined||child.attrs.get(match[1]!)===match[2]))found.push(child);found.push(...child.querySelectorAll(selector));}return found;
  }
  querySelector(selector:string):PickerElement|null{return this.querySelectorAll(selector)[0]??null;}
}
export const pickerTestDom=()=>{
  const root=new PickerElement();const document={createElement:()=>new PickerElement()} as unknown as Document;
  const action=(value:string):PickerElement=>{const node=root.querySelector('[data-file-download-picker-action="'+value+'"]');if(!node)throw new Error('Missing picker action '+value);return node;};
  const choice=(value:string):PickerElement=>{const node=root.querySelector('[data-file-download-picker-choice="'+value+'"]');if(!node)throw new Error('Missing picker choice '+value);return node;};
  return {root,document,action,choice};
};
