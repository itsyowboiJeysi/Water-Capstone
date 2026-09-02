// js/locations-loader.js — AgosTech
// Fetches and renders the Locations table on the dashboard.
// Defines window.viewLoaders.locations() — called when the Locations
// nav item is clicked, and again after a new location is added.

window.viewLoaders = window.viewLoaders || {};

window.viewLoaders.locations = async function loadLocationsView() {
  const tbody = document.getElementById('locations-tbody');
  if (!tbody) return;

  // Simple loading state
  tbody.innerHTML = `
    <tr><td colspan="4" style="text-align:center; padding:24px; color:#888;">
      Loading locations…
    </td></tr>
  `;

  try {
    const token = localStorage.getItem('token') || sessionStorage.getItem('token');
    const res = await fetch('http://localhost:5000/api/locations', {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) throw new Error('Failed to fetch locations');

    const locations = await res.json();

    if (!Array.isArray(locations) || locations.length === 0) {
      tbody.innerHTML = `
        <tr><td colspan="4" style="text-align:center; padding:24px; color:#888;">
          No locations added yet.
        </td></tr>
      `;
      return;
    }

    tbody.innerHTML = locations.map(loc => {
      const created = loc.created_at
        ? new Date(loc.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
        : '—';

      return `
        <tr data-location-id="${loc.location_id}">
          <td>${escapeHtml(loc.building_name)}</td>
          <td>${escapeHtml(loc.area_name)}</td>
          <td>${loc.description ? escapeHtml(loc.description) : '<span style="color:#aaa;">—</span>'}</td>
          <td>${created}</td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error('[AgosTech] loadLocationsView error:', err);
    tbody.innerHTML = `
      <tr><td colspan="4" style="text-align:center; padding:24px; color:#c0392b;">
        Couldn't load locations. Please refresh and try again.
      </td></tr>
    `;
  }
};

// Basic HTML-escaping so building names / descriptions can't break the table
// or inject markup if a user enters something unexpected.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Load immediately if the Locations view happens to be active on page load.
document.addEventListener('DOMContentLoaded', () => {
  const locView = document.getElementById('view-locations');
  if (locView && locView.classList.contains('active')) {
    window.viewLoaders.locations();
  }
});