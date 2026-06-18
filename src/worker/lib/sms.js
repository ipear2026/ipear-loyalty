// Normalize Greek text to GSM-7 compatible characters for SMS.
//
// GSM-7 supports only these uppercase Greek letters as-is:
//   Γ Δ Θ Λ Ξ Π Σ Φ Ψ Ω
// All others (including all lowercase and all accented forms) must be
// transliterated to Latin look-alikes, or the SMS gateway falls back to
// UCS-2 and the message cost doubles.
const GSM7_MAP = {
  'ά':'A','έ':'E','ή':'H','ί':'I','ΐ':'I','ό':'O','ύ':'Y','ΰ':'Y','ώ':'Ω',
  'Ά':'A','Έ':'E','Ή':'H','Ί':'I','Ό':'O','Ύ':'Y','Ώ':'Ω',
  'ϊ':'I','ϋ':'Y','Ϊ':'I','Ϋ':'Y',
  'Α':'A','Β':'B','Ε':'E','Ζ':'Z','Η':'H','Ι':'I','Κ':'K',
  'Μ':'M','Ν':'N','Ο':'O','Ρ':'P','Τ':'T','Υ':'Y','Χ':'X',
  'Γ':'Γ','Δ':'Δ','Θ':'Θ','Λ':'Λ','Ξ':'Ξ','Π':'Π','Σ':'Σ','Φ':'Φ','Ψ':'Ψ','Ω':'Ω',
  'α':'A','β':'B','γ':'Γ','δ':'Δ','ε':'E','ζ':'Z','η':'H','θ':'Θ',
  'ι':'I','κ':'K','λ':'Λ','μ':'M','ν':'N','ξ':'Ξ','ο':'O','π':'Π',
  'ρ':'P','σ':'Σ','ς':'Σ','τ':'T','υ':'Y','φ':'Φ','χ':'X','ψ':'Ψ','ω':'Ω',
};

export function normalizeGreekSMS(text) {
  let out = '';
  for (const ch of text) {
    out += GSM7_MAP[ch] || ch.toUpperCase();
  }
  return out;
}
