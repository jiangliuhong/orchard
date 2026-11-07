import type {Question} from '../../../src/migrations/types.js';
// Test-only questions; production declarations contain no manual inputs.
export const questions:Question[]=[
 {key:'test.questions/mode',type:'enum',label:'模式',description:'',default:'automatic',options:[{value:'automatic',label:'自动'},{value:'custom',label:'自定义'}]},
 {key:'test.questions/enabled',type:'boolean',label:'附加选项',description:'',default:false},
 {key:'test.questions/count',type:'integer',label:'数量',description:'',required:true,default:2,min:1,max:10},
 {key:'test.questions/secret',type:'secret',label:'秘密',description:'',required:true,when:{key:'test.questions/mode',equals:'custom'}},
 {key:'test.questions/name',type:'string',label:'名称',description:'',required:true,pattern:'^[a-z]+$',when:{key:'test.questions/enabled',equals:true}},
 {key:'test.questions/nested',type:'string',label:'下级条件',description:'',when:{key:'test.questions/name',equals:'nested'}},
];
