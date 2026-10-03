// Billing: invoices for the workspace (demo data, amounts in cents).

export function invoices() {
  return [
    { id: 'inv_1001', month: '2026-07', amount: 4800, paid: true },
    { id: 'inv_1002', month: '2026-08', amount: 4800, paid: true },
    { id: 'inv_1003', month: '2026-09', amount: 5600, paid: false },
  ];
}
