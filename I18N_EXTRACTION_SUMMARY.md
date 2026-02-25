# I18N Text Extraction Summary - Touch? (Encosta App)

**Date:** 2025-02-25  
**Status:** Complete  
**Source File:** `/sessions/inspiring-stoic-hopper/mnt/encosta/public/index.html` (15,805 lines)

---

## EXTRACTION RESULTS

### Files Generated

1. **I18N_TEXT_INVENTORY.md** (This project)
   - Comprehensive markdown documentation
   - Organized by category with detailed tables
   - Includes context, methodology, and translator notes
   - Best for: Documentation, review, context understanding

2. **i18n_translation_template.csv** (This project)
   - 630 unique text strings
   - Ready-to-use spreadsheet format
   - Columns: line, original_text, category, priority, source, context, translation, notes
   - Best for: Translation workflow, collaborative spreadsheet tools

### Statistics

| Metric | Count |
|--------|-------|
| Total Unique Strings | 630+ |
| HTML Elements (buttons, labels, placeholders, headers) | 245 |
| JavaScript Dynamic Text | 356 |
| Toast/Notification Messages | 200+ |
| Error Messages | 53+ |
| Input Placeholders | 49 |
| High Priority (alta) Strings | ~95 |
| Medium Priority (media) Strings | ~535 |

### By Category

| Category | Count | Examples |
|----------|-------|----------|
| Buttons | 151 | "Entrar", "Próximo", "Enviar" |
| Toast/Notifications | 201+ | "Email já verificado!", "Conta encontrada!" |
| Placeholders | 49 | "E-mail", "Senha", "Mensagem..." |
| Error Messages | 53+ | "Código inválido", "Sem conexão" |
| UI Labels | 29 | "Nickname", "Bio", "Profissão" |
| Section Headers | 16 | "Meu Painel", "Conversas ativas" |
| Dynamic Text | 155 | Dynamic assignments in JavaScript |
| Onboarding/Poetic | 15 | "Tudo nasce no gesto", "Toque para conectar" |

---

## KEY FEATURES OF THIS EXTRACTION

### What's Included

- ALL user-visible text in Portuguese (BR)
- Button labels and link text
- Input field placeholders and labels
- Form validation error messages
- Toast notifications and success messages
- Section titles and headers
- Modal and popup content
- Onboarding and instructional text
- Game interfaces
- Dynamic text set via JavaScript
- Accessibility labels (aria-label, title attributes)
- Commented i18n keys for future reference

### What's Excluded

- CSS-only content (pseudo-elements, animations)
- Code comments and documentation strings
- Variable names and function names
- SVG content and icon paths
- Meta tags and technical attributes
- Inline JavaScript logic (conditionals, operators)
- System URLs and API endpoints
- HTML entities (already decoded where applicable)

---

## TRANSLATION PRIORITY TIERS

### Alta (High Priority)
**~95 strings** - Core user experience paths that must be translated first

**Screens:**
- Onboarding flow (lines 1560-1595)
- Authentication (login, register, forgot password)
- Home screen navigation
- Profile and settings
- Main action buttons

**Examples:**
- "Tudo nasce no gesto"
- "Toque para conectar"
- "ENTRAR", "CRIAR CONTA"
- "Meu Painel", "Conversas ativas"

### Media (Medium Priority)
**~535 strings** - Secondary features, messages, and interactions

**Screens:**
- Chat and message interface
- Toast notifications
- Error messages
- Secondary screens (location, events, tipping)
- Game interfaces
- Payment/subscription screens

**Examples:**
- "Mensagem..."
- "Email de verificação enviado!"
- "Código inválido"
- "R$10/mês"

### Baixa (Low Priority)
**~0 strings** - Admin, operator, or rarely-seen content

**Currently:** No strings marked as baixa in this inventory

---

## IMPORTANT NOTES FOR TRANSLATORS

### 1. Preserve Formatting
- **Emojis:** Keep all emojis (✅, ⏳, ✉, ⚠️, ❤️) - they carry emotional meaning
- **HTML entities:** Some text has `&nbsp;`, `&#x2190;`, etc. - preserve these
- **Newlines:** Some messages contain line breaks - maintain them
- **Quotes:** Some strings have quotation marks in content - preserve case and position

### 2. Brand & Proper Nouns
These should NOT be translated:
- "Touch?" (app name)
- "Encosta" (platform name)
- "R$" (Brazilian Real currency)
- User-chosen nicknames

These SHOULD be translated:
- "Toque" (verb: to touch/tap)
- "Conexão" (connection)
- "Encontro" (meeting/encounter)

### 3. Cultural Considerations
The app has strong cultural elements:
- Zodiac/astrological references (signos, astros)
- Brazilian context (CPF, Mercado Pago, PIX)
- Poetic/philosophical tone ("Tudo nasce no gesto")
- Flirting and dating context

Translations should maintain:
- The intimate, casual tone
- Regional context (Brazil-specific)
- Poetic sensibility in onboarding

### 4. Format Specifications

**Phone Numbers:** (XX) 9XXXX-XXXX
**CPF:** XXX.XXX.XXX-XX
**Currency:** R$ (keep as-is)
**Email placeholder:** seu@email.com (translate "seu" if context allows)

### 5. Common Patterns

| English Pattern | Portuguese Pattern | Translation Rule |
|-----------------|-------------------|------------------|
| "Please..." | "Por favor, ..." | Use polite conditional |
| "Try again" | "Tente novamente" | Imperative, friendly |
| "Loading..." | "Carregando..." | Gerund form |
| "Error: X" | "Erro: X" | Capital E, colon, then message |

### 6. Special Contexts

**Error Messages:** 
- Clear, direct, action-oriented
- Example: "Código inválido. Verifique e tente novamente."

**Notifications (Toasts):**
- Short, encouraging, emoji-enhanced
- Example: "Email já verificado! ✅"

**Instructions:**
- Imperative, conversational
- Example: "Encoste os celulares, mostre o QR ou use código."

---

## TECHNICAL DETAILS

### Extraction Methodology

**Tools Used:**
- Python regex for pattern matching
- Manual review of high-priority strings
- Line-by-line parsing of HTML and JavaScript

**Patterns Captured:**

```
HTML:
- placeholder="..." 
- >text</button>, >text</span>, >text</div>
- <label>text</label>, <h1-h6>text</h*>
- title="...", aria-label="..."
- data-i18n="key"

JavaScript:
- showToast('text')
- .textContent = 'text'
- .innerHTML = 'text'
- msgs = { 'key': 'text' }
- Error/success message variables
```

**Quality Checks:**
- Removed duplicates (630 unique from 850+ occurrences)
- Filtered out code elements (variables, functions, comments)
- Verified context for each string
- Organized by screen and category

### How to Use the CSV

1. **Column Headers:**
   - `line` - Original line number in index.html (for reference)
   - `original_text` - The Portuguese text to translate
   - `category` - Type of string (button, error, placeholder, etc.)
   - `priority` - How important this is (alta/media)
   - `source` - Where it comes from (HTML/JavaScript)
   - `context` - Additional context (HTML pattern, screen name)
   - `translation` - FILL THIS IN with translated text
   - `notes` - Any special handling notes

2. **Workflow:**
   - Filter by `priority` to translate high-priority items first
   - Group by `category` or `source` for consistency
   - Use `context` to understand where text appears
   - Add your translation in the `translation` column
   - Add any notes about special handling in `notes`

3. **Quality Control:**
   - Verify tone matches (friendly vs. technical)
   - Check length (some UI has limited space)
   - Test special characters and emoji
   - Confirm brand terms remain untranslated

---

## NEXT STEPS FOR IMPLEMENTATION

### Phase 1: Translation (This Phase)
- Translate all "alta" priority strings
- Translate "media" strings
- Review for cultural appropriateness
- Add to translation memory/glossary

### Phase 2: Implementation
- Create i18n key mapping file (key -> translated text)
- Update JavaScript `.textContent` assignments
- Test all screens in target language
- Verify date/time/number formatting
- Test error messages and edge cases

### Phase 3: QA & Polish
- Linguistic review
- Screen-by-screen testing
- Accessibility check (aria-labels, etc.)
- RTL language support (if needed)
- User testing with native speakers

### Phase 4: Deployment
- Deploy translations with feature flag
- Monitor for UI overflow/truncation
- Gather user feedback
- Iterate on problematic strings

---

## REFERENCE: APP SCREENS & SECTIONS

### Main Screens (Lines 1400-2800)

| Screen | Lines | Priority | Key Strings |
|--------|-------|----------|-------------|
| Onboarding | 1560-1595 | alta | 5 onboarding slides |
| Login/Register | 1595-1750 | alta | 12+ auth UI strings |
| Home | 1700-1850 | alta | Navigation, greeting |
| Chat | 1900-2000 | alta | Message input, conversation UI |
| Profile | 2300-2500 | media | User details, settings |
| Location/Events | 2110-2160 | media | Map, event creation |
| Subscriptions | 2650-2780 | media | Plans (Plus, Selo), pricing |
| Tipping | 2128-2150 | media | Amount buttons, payment |

### JavaScript Sections (Lines 2790-15200)

| Section | Lines | Type | Examples |
|---------|-------|------|----------|
| Auth Handlers | 3000-3500 | dynamic | Login messages, errors |
| Screen Functions | 3500-7000 | UI management | Toast messages |
| Games | 9000-14000 | Game UI | Game messages, challenges |
| Voice Agent | 14000-15200 | AI interaction | Voice commands, responses |

---

## FILES IN THIS DELIVERY

```
/sessions/inspiring-stoic-hopper/mnt/encosta/

├── I18N_TEXT_INVENTORY.md              (Complete documentation - this file)
├── I18N_EXTRACTION_SUMMARY.md          (Quick reference)
├── i18n_translation_template.csv       (Ready for translation)
└── public/index.html                   (Original source file)
```

---

## QUESTIONS & SUPPORT

### Common Questions

**Q: Should I translate "Touch?" and "Encosta"?**
A: No - these are brand names. Keep them as-is.

**Q: How do I handle HTML entities like "&#x2190;"?**
A: The extraction has decoded these. Use the decoded character (in this case, ←).

**Q: What if a string is too long for the UI space?**
A: Add a note in the `notes` column. The dev team can adjust UI or create shorter versions.

**Q: Should I match the tone exactly?**
A: Yes. The app has a specific voice: poetic/casual for onboarding, clear/direct for errors, encouraging for notifications.

**Q: Are there context clues for ambiguous strings?**
A: Yes - use the `context` and `category` columns to understand where each string appears.

---

## VERSION HISTORY

| Date | Action | Details |
|------|--------|---------|
| 2025-02-25 | Extraction Complete | 630 unique strings identified and categorized |
| - | Files Generated | .md inventory, .csv template |
| - | Documentation | Complete methodology notes and translator guide |

---

**Status:** Ready for translation team  
**Contact:** See project documentation for implementation questions
