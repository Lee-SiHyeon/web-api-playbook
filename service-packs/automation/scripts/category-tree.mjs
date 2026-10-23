import {fetchCategoryTree} from '../src/category-client.mjs';
import {refreshCategories} from '../src/category-refresh.mjs';
import {printHelpIfRequested} from './usage.mjs';
if(printHelpIfRequested('Usage: node scripts/category-tree.mjs <frontier-file>'))process.exit(0);
const file=process.argv[2];
if(!file){console.error('Usage: node scripts/category-tree.mjs <frontier-file>');process.exitCode=2;}
else try{console.log(JSON.stringify(await refreshCategories(file,()=>fetchCategoryTree(process.env.COUPANG_REVIEW_COOKIE))));}
catch(error){console.error(error.message);process.exitCode=1;}
