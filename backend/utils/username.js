// The one rule for a username chosen by a person (invitation and public registration).
//
// There was no rule at all, and the username is interpolated into the HTML of the summary
// emails (services/summaries.js) - which a user can send to ANY address through the
// "send a test summary" endpoints. A username like `<a href="https://evil">Zweryfikuj
// konto</a>` turned the app's own Mailgun domain into a phishing sender. The templates now
// escape it as well (utils/html.js); this rule is the other half, so that a username is a
// name and not markup.
//
// No '@': /api/login matches `username = ? OR email = ?`, so a username that looks like
// someone else's email address could collide with that person's login identifier.
// 3-32 characters of [a-zA-Z0-9_.-] is the set Google sign-in already reduces generated
// usernames to (routes/auth.js), so both ways of creating an account agree.
const USERNAME_REGEX = /^[a-zA-Z0-9_.-]{3,32}$/;

const USERNAME_RULE_MESSAGE = 'Nazwa użytkownika musi mieć 3-32 znaki i może zawierać tylko litery, cyfry oraz znaki _ . -';

function isValidUsername(username) {
  return typeof username === 'string' && USERNAME_REGEX.test(username);
}

module.exports = { isValidUsername, USERNAME_REGEX, USERNAME_RULE_MESSAGE };
