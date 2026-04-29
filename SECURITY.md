# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report vulnerabilities via [GitHub's private vulnerability reporting](https://github.com/qwandery/trageti/security/advisories/new) or email **security@qwandery.com**.

Include a description of the vulnerability, steps to reproduce, and potential impact. We will acknowledge receipt within 48 hours and aim to release a fix within 14 days for critical issues.

## Scope

This library operates exclusively on the SQLite database connection provided by the caller. It does not open network connections, write files, or manage secrets. Security responsibilities in scope include:

- SQL injection via library-generated queries
- Data leakage via error messages or logs
- Incorrect enforcement of namespace isolation in queries
