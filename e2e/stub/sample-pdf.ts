/** Synthetic two-page PDF. No private documents are test fixtures. */
export function samplePdf(): string {
 const content=(text:string)=>`BT /F1 24 Tf 40 160 Td (${text}) Tj ET`;
 const first=content('Shahi sample PDF'),second=content('Page two - private sample');
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
 '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${first.length} >>\nstream\n${first}\nendstream`,`<< /Length ${second.length} >>\nstream\n${second}\nendstream`];
 let pdf='%PDF-1.4\n';const offsets=[0];
 objects.forEach((object,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;});
 const xref=pdf.length;pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
 for(const offset of offsets.slice(1))pdf+=`${String(offset).padStart(10,'0')} 00000 n \n`;
 return pdf+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
