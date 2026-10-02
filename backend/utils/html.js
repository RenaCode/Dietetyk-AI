// HTML escaping for values interpolated into server-built HTML (emails, admin reports).
// Moved here from services/adminReport.js so that services/summaries.js can use the same
// function instead of interpolating user-controlled strings raw.
function escapeHtml(text) {
  if (text === null || text === undefined || text === '') return '';
  return text
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = { escapeHtml };
