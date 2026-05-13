// Known admin/internal paths to probe on the SF Experience Cloud origin.
// Finding = HTTP 200 without credentials (fully unauthenticated access).
// Exported as { path, label } pairs so the popup can show human-readable names.

export const HOME_URL_PROBES = [
  { path: '/services/data/',                          label: 'REST API root' },
  { path: '/services/apexrest/',                      label: 'Apex REST' },
  { path: '/_ui/common/apex/debug/ApexCSIAPI',        label: 'Apex Debug API' },
  { path: '/lightning/setup/SetupOneHome/home',        label: 'Lightning Setup' },
  { path: '/setup/ui/listApex.apexp',                  label: 'Setup — Apex Classes' },
  { path: '/home/home.jsp',                            label: 'Legacy SF Home' },
  { path: '/_ui/core/userprofile/ui/ProfilePage',      label: 'User Profile UI' },
  { path: '/services/Soap/u/56.0',                     label: 'SOAP API' },
  { path: '/sfsites/c/LightningOut.js',                label: 'Lightning Out (sfsites)' },
  { path: '/_slds/styles/salesforce-lightning-design-system.min.css', label: 'SLDS assets' },
];
