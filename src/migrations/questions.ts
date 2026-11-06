import { MigrationError, type Question } from './types.js';
export function questionActive(question:Question,questions:Question[],answers:Record<string,unknown>,seen=new Set<string>()):boolean{
 if(!question.when)return true;
 if(seen.has(question.key))throw new MigrationError('CHAIN_UNSUPPORTED');seen.add(question.key);
 const parent=questions.find(value=>value.key===question.when!.key);if(!parent)throw new MigrationError('CHAIN_UNSUPPORTED');
 if(!questionActive(parent,questions,answers,seen))return false;
 const value=Object.hasOwn(answers,parent.key)?answers[parent.key]:parent.type==='secret'?undefined:parent.default;
 return value===question.when.equals;
}
export function validateAnswers(questions:Question[],answers:Record<string,unknown>) {
  const errors:Record<string,string>=Object.create(null), normalized:Record<string,unknown>=Object.create(null);
  for(const key of Object.keys(answers))if(!questions.some(q=>q.key===key))errors[key]='未知字段';
  for(const question of questions){
    const active=questionActive(question,questions,answers);
    if(!active){if(Object.hasOwn(answers,question.key))errors[question.key]='当前分支不接受此字段';continue;}
    const value=Object.hasOwn(answers,question.key)?answers[question.key]:question.type==='secret'?undefined:question.default;
    if(value===undefined||value===''){if(question.required)errors[question.key]='请填写此项';continue;}
    let valid=true;
    if(question.type==='boolean')valid=typeof value==='boolean';
    else if(question.type==='integer')valid=typeof value==='number'&&Number.isSafeInteger(value)&&(question.min===undefined||value>=question.min)&&(question.max===undefined||value<=question.max);
    else valid=typeof value==='string'&&(question.min===undefined||value.length>=question.min)&&(question.max===undefined||value.length<=question.max)&&(!question.pattern||new RegExp(question.pattern).test(value))&&(question.type!=='enum'||!!question.options?.some(o=>o.value===value));
    if(!valid)errors[question.key]='值不符合约束';else normalized[question.key]=value;
  }
  return {fieldErrors:errors,answers:normalized};
}
