# Fonts

`inter-latin.woff2` (Inter) and `oswald-latin.woff2` (Oswald) are the Latin
subsets of the two variable fonts the app uses, downloaded unmodified from
Google Fonts. Both are licensed under the SIL Open Font License 1.1
(https://openfontlicense.org), which permits self-hosting and redistribution.

They are self-hosted instead of linked from fonts.googleapis.com because that
stylesheet blocked the first paint on a slow connection, and because a
same-origin file is cached by `sw.js` and therefore also works offline.
