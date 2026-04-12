MV Cars — versione pronta per Aruba Hosting Linux

Credenziali iniziali admin:
- username: admin
- password: MVcars!2026Admin

IMPORTANTE:
- entra subito in /admin/
- cambia immediatamente la password dalla sezione Sicurezza
- il sito pubblico legge le auto da /data/cars.json
- il pannello admin salva su /data/cars.json e carica le foto in /data/uploads/

Come caricare su Aruba:
1. Carica tutto il contenuto dello zip dentro la root del sito.
2. Assicurati che PHP sia attivo.
3. Apri il sito pubblico normalmente.
4. Apri /admin/ per entrare nel gestionale.

Note tecniche:
- questa versione non usa Node.js
- il login è gestito in PHP con sessione server-side
- la password NON è salvata in chiaro nel frontend
- il file sensibile è data/admin-user.php, che contiene solo l'hash password
