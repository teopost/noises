# Regole del progetto Noises

## Testo e punteggiatura
- **Niente em dash** (il trattino lungo, carattere Unicode U+2014), in nessun file: codice, commenti, testi dell'interfaccia, traduzioni in `frontend/i18n.js`,
  README, sito in `docs/`, messaggi di log, note di rilascio. Al suo posto usa il trattino normale `-`
  (per esempio `Noises - Stem Splitter`, `Gruppo eliminato - Ctrl+Z per annullare`).
- Prima di chiudere un lavoro controlla che non ne siano rimasti: `git grep -nP '\x{2014}'` non deve trovare niente.
