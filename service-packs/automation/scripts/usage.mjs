export function printHelpIfRequested(usage){
 if(!process.argv.slice(2).some(argument=>argument==='--help'||argument==='-h'))return false;
 process.stdout.write(usage+'\n');
 return true;
}
