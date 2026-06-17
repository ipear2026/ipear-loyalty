import { getDb, collection, getDocs } from '../services/firebase.js';
import { tier } from '../utils.js';
import { toast } from './ui.js';

export async function exportCSV() {
  try {
    const db = getDb();
    const snap = await getDocs(collection(db, 'ipear_customers'));
    const rows = [['Κάρτα', 'Ονοματεπώνυμο', 'Τηλέφωνο', 'Email', 'Πόντοι', 'Lifetime Πόντοι', 'Tier', 'Γενέθλια', 'Ημ. Εγγραφής']];
    snap.forEach(d => {
      const c = d.data();
      const t = tier(c.totalPoints || c.points || 0);
      rows.push([
        c.card || '', c.name || '', c.phone || '', c.email || '',
        c.points || 0, c.totalPoints || 0, t.name,
        c.birthday || '',
        c.createdAt ? new Date(c.createdAt).toLocaleDateString('el-GR') : '',
      ]);
    });
    const bom = '﻿';
    const csvSafe = v => {
      let s = String(v).replace(/"/g, '""');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return `"${s}"`;
    };
    const csv = bom + rows.map(r => r.map(csvSafe).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ipear-pelates-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    toast('✅ CSV εξήχθη επιτυχώς!', 'success');
  } catch (e) {
    toast('❌ ' + e.message, 'error');
  }
}
