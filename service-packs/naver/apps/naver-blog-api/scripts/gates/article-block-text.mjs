import {text, tableRows} from './publication-document.mjs';

// Contract checks must see the same visible content whether it is prose or a
// native table. Invalid tables throw rather than supplying unvalidated cells.
export function articleBlockText(block) {
  if (block?.type === 'table') return tableRows(block).map(row => row.join(' ')).join('\n');
  return text(block?.text || (block?.items || []).join(' ') || block?.label || '');
}

// Preserve row and column identity for conditions in comparison tables.
export function articleTableCells(blocks) {
  return blocks.filter(block => block.type === 'table').flatMap(block => {
    const [columns,...rows]=tableRows(block);
    return rows.flatMap(row=>row.map((value,index)=>({rowLabel:row[0],column:columns[index],value,rowText:row.join(' ')})));
  });
}
