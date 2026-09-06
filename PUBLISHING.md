# Publikacja w Visual Studio Marketplace

Ten dokument opisuje całą procedurę publikacji rozszerzenia **Worker Board**
w Visual Studio Marketplace tak, żeby dała się wykonać bez szukania
czegokolwiek w sieci. Rozszerzenie jest bezpłatne — publikacja niczego nie
kosztuje ani wydawcy, ani użytkowników.

**Stan na dziś:** wydawca `dtcode` już istnieje, a właściciel dysponuje
ważnym tokenem PAT z odpowiednim zakresem (zweryfikowanym poleceniem
`verify-pat` — patrz sekcja 2). Publikacja jest więc w pełni wykonalna z
wiersza poleceń, bez żadnego ręcznego kroku w przeglądarce. Sekcje 1 i 2
opisują mimo to procedurę **od zera** — potrzebną tylko, gdyby trzeba było
założyć nowego wydawcę albo odtworzyć dostęp po utracie tokenu.

## 1. Warunek wstępny: publisher

Publisher w Visual Studio Marketplace to byt **osobny od konta GitHub** —
posiadanie repozytorium na GitHubie niczego tu nie załatwia.

**Stan faktyczny:** wydawca o identyfikatorze `dtcode` już istnieje i jest
powiązany z organizacją Azure DevOps właściciela. Pole `publisher` w
`package.json` (`"dtcode"`) już się z nim zgadza — nic w tym punkcie nie
trzeba robić.

Procedura odtworzeniowa (nowy wydawca lub konto zakładane od zera):

1. Wejdź na `https://marketplace.visualstudio.com/manage`.
2. Zaloguj się kontem Microsoft / Entra ID.
3. Załóż publishera — wymaga to organizacji Azure DevOps (jeśli jej nie ma,
   portal poprowadzi przez jej założenie przy okazji).
4. Identyfikator wydawcy **musi być identyczny** z polem `publisher` w
   `package.json` tego repozytorium.

**Jeśli `dtcode` jest zajęte** (scenariusz zakładania od zera na innym
koncie): wybierz inny identyfikator wydawcy na portalu, a następnie zmień
pole `"publisher"` w `package.json` na tę samą wartość. Bez tej zgodności
publikacja się nie powiedzie — `vsce` publikuje pod wydawcą wskazanym w
manifeście, nie pod tym, którym się zalogowano.

## 2. Token dostępu (PAT)

**Stan faktyczny:** właściciel ma już PAT z zakresem `Marketplace → Manage`
(ten sam token jest używany także przez integrację Azure DevOps do innych
celów) — nie trzeba go zakładać ponownie. Miejsce jego przechowywania
(konfiguracja MCP) nie jest tu opisywane celowo.

**Zanim użyjesz istniejącego tokenu do publikacji, sprawdź, że ma właściwy
zakres** — token do innych integracji (np. work items) niekoniecznie ma
uprawnienie do Marketplace:

```powershell
npx @vscode/vsce verify-pat dtcode -p <TOKEN>
```

Komunikat sukcesu wygląda tak:

```
The Personal Access Token verification succeeded for the publisher 'dtcode'.
```

Jeśli token nie ma zakresu Marketplace, ta komenda kończy się błędem od
razu — to szybsza droga do odpowiedzi niż dowiadywanie się o tym z HTTP 401
w trakcie `vsce publish`.

> **Token daje prawo publikowania pod tożsamością wydawcy `dtcode`.** Nigdy
> nie commituj go do repozytorium ani nie wklejaj w treść rozmów/PR-ów.

Procedura odtworzeniowa (nowy token — token utracony, wygasły albo
zakładany po raz pierwszy):

1. Wejdź na `https://dev.azure.com/<organizacja>/_usersSettings/tokens`.
2. **Organizacje:** ustaw `All accessible organizations` (nie tylko bieżącą)
   — inaczej token nie zadziała z publisherem powiązanym z inną organizacją.
3. **Uprawnienia (Scopes):** `Marketplace` → `Manage`.
4. Wygeneruj token i **skopiuj go od razu** — portal Azure DevOps pokazuje
   pełną wartość tokenu **tylko raz**, bezpośrednio po utworzeniu.

## 3. Logowanie i publikacja

Zalogowanie zapisuje token lokalnie i pozwala pomijać `-p <TOKEN>` przy
kolejnych publikacjach:

```powershell
npx @vscode/vsce login dtcode
npx @vscode/vsce publish
```

Wariant bez zapamiętanego logowania — token podany bezpośrednio w komendzie:

```powershell
npx @vscode/vsce publish -p <TOKEN>
```

Publikacja z gotowego, już zbudowanego pakietu `.vsix` (np. tego
wyprodukowanego przez `install.ps1`), zamiast budowania od nowa:

```powershell
npx @vscode/vsce publish --packagePath worker-board-0.5.1.vsix
```

Podbicie wersji przy okazji publikacji (aktualizuje `version` w
`package.json`, tworzy commit i tag gita, a następnie publikuje):

```powershell
npx @vscode/vsce publish patch   # 0.5.1 -> 0.5.2
npx @vscode/vsce publish minor   # 0.5.1 -> 0.6.0
npx @vscode/vsce publish major   # 0.5.1 -> 1.0.0
```

## 4. Weryfikacja wydawcy (opcjonalna)

Domain verification na `https://marketplace.visualstudio.com/manage`:
podajesz domenę, dodajesz wskazany rekord **TXT** w DNS tej domeny, czekasz
na weryfikację przez Microsoft. Efekt to niebieski znacznik zaufania przy
nazwie wydawcy na stronie rozszerzenia.

To krok **opcjonalny** — nie blokuje ani nie jest wymagany do publikacji.

## 5. Po publikacji

Rozszerzenie pojawia się w Marketplace zwykle w ciągu kilku minut od
`vsce publish`.

Instalacja przez użytkowników:

```powershell
code --install-extension dtcode.worker-board
```

albo z panelu **Extensions** w VS Code (wyszukaj „Worker Board”).

Strona rozszerzenia w sklepie:
`https://marketplace.visualstudio.com/items?itemName=dtcode.worker-board`

## 6. Alternatywa: Open VSX

**Open VSX** to niezależny rejestr używany m.in. przez VSCodium i Theia
(edytory bez dostępu do Marketplace Microsoftu, z powodów licencyjnych).
Publikacja tam jest **opcjonalna** i całkowicie niezależna od kroków 1–5.

1. Załóż konto Eclipse (`https://accounts.eclipse.org`).
2. Podpisz **Publisher Agreement** Eclipse (jednorazowo, elektronicznie).
3. Załóż namespace w Open VSX **zgodny z `publisher`** w `package.json`
   (`dtcode`).
4. Wygeneruj token dostępu w ustawieniach konta Open VSX.
5. Publikuj:
   ```powershell
   npx ovsx publish -p <TOKEN>
   ```

## 7. Czego nie da się zautomatyzować

Przy istniejącym wydawcy i ważnym tokenie **cała publikacja jest wykonalna
z wiersza poleceń** (sekcja 3) — nie wymaga żadnej przeglądarki. Ręcznego
logowania w przeglądarce wymagają wyłącznie:

- **Pierwsze założenie wydawcy** (sekcja 1) — jednorazowe, przez konto
  Microsoft/Entra ID na `marketplace.visualstudio.com/manage`.
- **Weryfikacja domeny** (sekcja 4) — opcjonalna, wymaga dodania rekordu TXT
  w panelu DNS i potwierdzenia na stronie zarządzania wydawcą.

Żadnego z tych dwóch kroków nie da się wykonać skryptem — obu dotyczy dziś
sytuacja „już zrobione” (patrz stan faktyczny w sekcjach 1–2), więc nie
stoją one na drodze do kolejnych publikacji.
