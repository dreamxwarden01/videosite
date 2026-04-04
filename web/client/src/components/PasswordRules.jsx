/**
 * PasswordRules — live password requirement indicators.
 *
 * Rules are grey (neutral) when password is empty, then turn green (pass) or
 * red (fail) as the user types.
 */
export function checkPasswordComplexity(pw) {
  const rules = { length: false, complexity: false };
  if (!pw) return { rules, error: '' };

  rules.length = pw.length >= 8;

  let cats = 0;
  if (/[A-Z]/.test(pw)) cats++;
  if (/[a-z]/.test(pw)) cats++;
  if (/[0-9]/.test(pw)) cats++;
  if (/[^A-Za-z0-9]/.test(pw)) cats++;
  rules.complexity = cats >= 3;

  let error = '';
  if (!rules.length) error = 'Password must be at least 8 characters long.';
  else if (!rules.complexity) error = 'Must include at least 3 of: uppercase, lowercase, digits, special characters.';

  return { rules, error };
}

export default function PasswordRules({ password }) {
  const hasInput = password.length > 0;
  const { rules } = checkPasswordComplexity(password);

  const ruleItems = [
    { key: 'length', label: 'At least 8 characters' },
    { key: 'complexity', label: 'Includes 3 of: uppercase, lowercase, digit, special character' },
  ];

  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0', fontSize: '12px', lineHeight: '1.7' }}>
      {ruleItems.map(({ key, label }) => {
        let color = '#9ca3af'; // grey (neutral)
        let icon = '\u2022';   // bullet
        if (hasInput) {
          if (rules[key]) {
            color = '#16a34a'; // green
            icon = '\u2713';   // check
          } else {
            color = '#dc3545'; // red
            icon = '\u2717';   // cross
          }
        }
        return (
          <li key={key} style={{ color }}>
            <span style={{ display: 'inline-block', width: '16px', textAlign: 'center', marginRight: '4px' }}>{icon}</span>
            {label}
          </li>
        );
      })}
    </ul>
  );
}
