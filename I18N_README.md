# I18N Text Inventory - Touch? (Encosta App)

Complete internationalization (i18n) text extraction for the Touch? application.

**Date:** 2025-02-25  
**Status:** Complete and ready for translation  
**Source:** `/public/index.html` (15,805 lines)

## Quick Start

### For Translators
1. Download **`i18n_translation_template.csv`**
2. Open in Excel, Google Sheets, or your translation tool
3. Fill the `translation` column with translated text
4. Sort by `priority` column to see high-priority items first

### For Documentation
1. Read **`I18N_TEXT_INVENTORY.md`** for complete inventory with context
2. Check **`I18N_EXTRACTION_SUMMARY.md`** for quick reference and methodology

## Files Included

| File | Size | Purpose |
|------|------|---------|
| **i18n_translation_template.csv** | 38 KB | Spreadsheet with 630 strings ready for translation |
| **I18N_TEXT_INVENTORY.md** | 17 KB | Complete documentation with all text organized by category |
| **I18N_EXTRACTION_SUMMARY.md** | 11 KB | Quick reference, statistics, and translator guidelines |
| **I18N_README.md** | This file | Navigation guide |

## Statistics

- **Total Strings:** 630 unique texts
- **Source Occurrences:** 850+ (duplicates removed)
- **High Priority (alta):** 95 strings (15%)
- **Medium Priority (media):** 535 strings (85%)

### By Category
- Buttons: 151
- Toast/Notifications: 201+
- Placeholders: 49
- Error Messages: 53+
- UI Labels: 29
- Section Headers: 16
- Dynamic Text: 155
- Onboarding/Poetic: 15

## Key Screens

### High Priority
- Onboarding (5 slides with poetic descriptions)
- Authentication (login, register, password reset)
- Home screen and navigation
- Main action buttons
- Core screen titles

### Medium Priority
- Toast notifications and feedback
- Error messages and validation
- Chat interface
- Secondary screens (location, events, tipping)
- Games and voice agent
- Payment and subscriptions

## CSV Columns

| Column | Description |
|--------|-------------|
| `line` | Line number in source HTML (for reference) |
| `original_text` | Portuguese BR text to translate |
| `category` | Type: button, error, toast, placeholder, label, etc. |
| `priority` | alta (high) or media (medium) |
| `source` | HTML element or JavaScript dynamic |
| `context` | Additional context or pattern |
| `translation` | YOUR TRANSLATIONS GO HERE |
| `notes` | Special handling notes |

## Important Notes

### Preserve
- Emojis: ✅, ⏳, ✉, ⚠️, ❤️, 🔄
- Brand names: "Touch?", "Encosta"
- Currency format: "R$"
- HTML entities

### Translate
- All user-visible text
- Section titles and headers
- Button labels and actions
- Error messages
- Toast notifications
- Onboarding descriptions

### Don't Translate
- Brand names: Touch?, Encosta
- Proper nouns and user handles
- URLs and API references
- Currency: R$ (already in Portuguese)

## Tone Guidelines

| Context | Tone | Example |
|---------|------|---------|
| Onboarding | Poetic, intimate | "Tudo nasce no gesto" |
| Buttons | Action-oriented, friendly | "ENTRAR", "Enviar" |
| Errors | Clear, helpful, direct | "Código inválido. Tente novamente." |
| Notifications | Encouraging, emoji-enhanced | "Email já verificado! ✅" |
| Instructions | Conversational, imperative | "Encoste os celulares..." |

## Extraction Methodology

### HTML Patterns
- `placeholder="..."` - Input hints
- `>text</button>` - Button content
- `>text</span>`, `>text</div>` - Element content
- `<label>text</label>` - Form labels
- `<h1-h6>text</h*>` - Headers
- `title="..."` - Tooltips
- `aria-label="..."` - Accessibility labels

### JavaScript Patterns
- `showToast('text')` - User notifications
- `.textContent = 'text'` - Dynamic text
- `.innerHTML = 'text'` - Dynamic HTML
- Error/message variables

### Quality Assurance
- Filtered out code elements
- Removed CSS-only content
- Excluded SVG and icons
- Removed duplicates
- Verified context for each string

## Format Standards

**Phone:** (XX) 9XXXX-XXXX  
**CPF:** XXX.XXX.XXX-XX  
**Dates:** DD/MM/YYYY  
**Decimal:** Use comma (1,50 not 1.50)  
**Currency:** R$ (keep as-is)

## Next Steps

1. **Translation Phase**
   - Download CSV file
   - Fill translation column
   - Prioritize "alta" items first
   - Add notes for special cases

2. **Implementation Phase**
   - Create i18n key mapping
   - Update JavaScript assignments
   - Test all screens
   - Check for UI issues

3. **QA & Polish**
   - Native speaker review
   - Screen testing
   - Accessibility check
   - User feedback

4. **Deployment**
   - Deploy with feature flag
   - Monitor for issues
   - Gather feedback
   - Iterate

## Questions?

### Common Questions

**Q: Translate "Touch?"?**  
A: No - it's a brand name.

**Q: Preserve emojis?**  
A: Yes - they carry emotional meaning.

**Q: Match tone exactly?**  
A: Yes - app has specific voice.

**Q: HTML entities like "&#x2190;"?**  
A: Already decoded, use the character (←).

**Q: String too long for UI?**  
A: Add note in notes column for dev team.

### Getting More Context

- Use `context` column for where text appears
- Check `source` column for HTML vs JavaScript
- Reference `line` number to find in source file
- Group by `category` for consistency

## Technical Implementation

### When Ready to Implement

1. Create translation object in JavaScript:
```javascript
const translations = {
  'home_title': 'Translated Text',
  'button_send': 'Translated Button',
  // ... all 630 strings
};
```

2. Update i18n function calls:
```javascript
function i18n(key) {
  return translations[key] || key;
}
```

3. Update HTML elements:
```html
<h2 data-i18n="home_title"></h2>
```

4. Update JavaScript assignments:
```javascript
element.textContent = i18n('button_text');
```

## Resources

- **Source:** `/public/index.html` (15,805 lines)
- **Generated:** 2025-02-25
- **Status:** Production-ready
- **Version:** 1.0

## License & Usage

This extraction is for internal translation work on the Touch? application.
All text is proprietary and confidential.

---

**Ready to translate!** Start with the CSV file and follow the tone guidelines.
