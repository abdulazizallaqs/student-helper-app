/**
 * Lightweight, dependency-free bilingual (English / Arabic) support.
 *
 * How it works:
 *  - Elements opt in with `data-i18n="some.key"` (its textContent is swapped)
 *    or `data-i18n-placeholder="some.key"` (its placeholder attribute is
 *    swapped). Everything else on the page is left alone, so icons, dynamic
 *    user content (file titles/descriptions, chat messages, etc.) and
 *    anything not explicitly marked is never touched.
 *  - The chosen language is remembered per-browser in localStorage, so it
 *    carries across pages/navigations once a visitor picks one.
 *  - Each page can set `data-i18n-default="ar"` (or "en") on <html> to pick
 *    what a FIRST-TIME visitor (no saved preference yet) sees on that page -
 *    this lets pages that already ship one language as their hardcoded
 *    default (e.g. the Arabic splash page) keep behaving the same until the
 *    visitor actively switches, instead of every page silently changing on
 *    first load.
 *
 * Add a language toggle button anywhere with:
 *   <button type="button" class="lang-toggle-btn" onclick="toggleLang()"></button>
 * Its label is kept in sync automatically (shows the language you'd SWITCH
 * TO, e.g. "EN" while the page is in Arabic).
 */

const SH_I18N_STORAGE_KEY = 'sh-lang';

const SH_TRANSLATIONS = {
  en: {
    'nav.about': 'About',
    'nav.features': 'Features',
    'nav.how': 'How it works',
    'nav.login': 'Log in',
    'nav.signup': 'Create account',

    'hero.eyebrow': 'Powered by AI',
    'hero.titlePrefix': 'Your notes become ',
    'hero.titleSuffix': ' in one click',
    'hero.lead': 'Upload your study files, organize them by category, and share them with classmates — AI generates quiz questions and flashcards from that same content, and answers your questions right inside the app.',
    'hero.cta': 'Start for free',
    'hero.ctaSecondary': 'See the features',
    'hero.note': 'Your data stays yours — AI is only ever used on the content you choose to upload.',

    'demo.frontTag': 'Sample flashcard',
    'demo.frontText': "What's the fastest way to turn a PDF summary into a quiz?",
    'demo.frontHint': 'Click to see the answer',
    'demo.backTag': 'Answer',
    'demo.backText': 'Upload the file on the "For Me" or "My Files" page and click "Quick Quiz" — AI handles the rest.',
    'demo.backHint': 'Click to flip back',
    'demo.caption': 'This is just an example — your real cards are built from your own files',

    'about.heading': 'About Student Helper',
    'about.subheading': 'A collaborative study platform for students: one place to upload your notes, find your classmates’ files, and let AI help you review faster and smarter.',
    'about.copy': 'Instead of juggling scattered files and WhatsApp groups, Student Helper brings every study resource into one place: upload, categorize, and share with who you choose. And when you need to review fast before an exam, AI builds you a short quiz or flashcards from that same file — no manual work required.',
    'about.stat1Title': 'Upload & share',
    'about.stat1Sub': 'PDF, image and document files',
    'about.stat2Title': 'Built-in AI',
    'about.stat2Sub': 'Quizzes, flashcards and summaries',
    'about.stat3Title': 'Student interaction',
    'about.stat3Sub': 'Comments and messages on every file',

    'features.heading': 'Everything you need to study smart',
    'features.subheading': 'Features built around the real student journey: from uploading a file to your final review before the exam.',
    'features.f1Title': 'Fast file uploads',
    'features.f1Text': 'Upload your notes as PDF, images or Word docs, and categorize them by subject so you can find them again easily.',
    'features.f2Title': 'AI quick quiz',
    'features.f2Text': 'Turn any PDF into an automatic multiple-choice quiz, built from that file’s exact content.',
    'features.f3Title': 'Flashcards',
    'features.f3Text': 'Generate question-and-answer flashcards from your notes, and review them quickly before an exam from any device.',
    'features.f4Title': 'AI study buddy',
    'features.f4Text': 'Ask the study assistant anything, or have it summarize a long file in seconds.',
    'features.f5Title': 'Favorites & organization',
    'features.f5Text': 'Bookmark the files that matter and search quickly across everything available to you.',
    'features.f6Title': 'Comments & messages',
    'features.f6Text': 'Comment on classmates’ files and send direct messages to coordinate group study.',

    'how.heading': 'Get started in three simple steps',
    'how.subheading': 'No complicated setup — sign up, upload, and review.',
    'how.s1Title': 'Create an account',
    'how.s1Text': 'Sign up with your email in under a minute, no hassle.',
    'how.s2Title': 'Upload your files',
    'how.s2Text': 'Add your notes and categorize them by subject to stay organized from day one.',
    'how.s3Title': 'Review with AI',
    'how.s3Text': 'Generate a quiz or flashcards, or ask the assistant directly.',

    'faq.heading': 'Frequently asked questions',
    'faq.subheading': 'What you should know before you start.',
    'faq.q1': 'Is the app free?',
    'faq.a1': 'Yes — creating an account, uploading files, and using the AI tools are all available at no cost.',
    'faq.q2': 'What file types can I upload?',
    'faq.a2': 'PDF, images, Word documents and compressed files. The AI tools (quiz and flashcards) currently support PDF files.',
    'faq.q3': 'Are my data and files safe?',
    'faq.a3': 'Your files are tied to your account only, and any content you upload is used with AI solely to generate your own quizzes, flashcards and summaries — you can review the full details in the Privacy Policy.',
    'faq.q4': 'What’s the difference between "Quick Quiz" and "Flashcards"?',
    'faq.a4': '"Quick Quiz" generates multiple-choice questions that test your understanding, while "Flashcards" gives you short question-and-answer cards to review quickly — both are built from the same file content.',

    'cta.heading': 'Ready to start studying smarter?',
    'cta.subheading': 'It’s free, and getting started is faster than you’d think.',
    'cta.button': 'Create a free account',

    'footer.privacy': 'Privacy Policy',
    'footer.terms': 'Terms of Service',

    'login.header': 'User Login',
    'login.username': 'Username',
    'login.password': 'Password',
    'login.button': 'Login',
    'login.or': 'OR',
    'login.google': 'Sign in with Google',
    'login.createAccount': 'Create Account',

    'create.header': 'Create Account',
    'create.name': 'Name',
    'create.email': 'Email',
    'create.username': 'Users name',
    'create.password': 'Password',
    'create.termsPrefix': 'I agree to the',
    'create.termsAnd': 'and',
    'create.button': 'Create',

    'dashboard.searchPlaceholder': 'Type to Search...',
    'dashboard.recommended': 'Recommended for You',

    // --- shared navigation ------------------------------------------------
    'nav.account': 'My account',
    'nav.messages': 'Messages',
    'nav.aiBuddy': 'AI Study Buddy',
    'nav.addFile': 'Add a file',
    'nav.files': 'Files',
    'nav.favorites': 'Favourites',
    'nav.logout': 'Log out',
    'nav.logoutConfirm': 'Log out of Student Helper?',
    'nav.search': 'Search',

    // --- common -----------------------------------------------------------
    'common.searchPlaceholder': 'Type to Search...',
    'common.loading': 'Loading...',
    'common.open': 'Open',
    'common.chat': 'Chat',
    'common.details': 'Details',
    'common.back': 'Back',
    'common.uploadedBy': 'Uploaded by:',
    'common.noDescription': 'No description was added for this file.',
    'common.refresh': 'Please refresh the page.',
    'common.sessionExpired': 'Your session has expired. Please log in again.',

    // --- file lists -------------------------------------------------------
    'files.forMe': 'For Me',
    'files.myFiles': 'My Files',
    'files.summarize': 'Sum',
    'files.aiSummary': 'AI Summary',
    'files.addFavorite': 'Add to favourites',
    'files.removeFavorite': 'Remove from favourites',
    'files.addedFavorite': 'Added to favourites',
    'files.removedFavorite': 'Removed from favourites',
    'files.edit': 'Edit this file',
    'files.emptyForMe': 'No files have been shared with you yet.',
    'files.emptyMine': 'You have not uploaded anything yet - add your first file.',
    'files.emptyFavorites': 'You have not saved any file to your favourites yet.',
    'files.emptySearch': 'No files match your search.',
    'search.searching': 'Searching...',
    'search.resultsFor': 'results for',
    'search.resultFor': 'result for',
    'search.noResultsFor': 'Nothing matched',
    'search.approximate': 'No exact match - showing the closest files.',
    'search.related': 'Includes related and Arabic/English equivalents.',
    'search.someByMeaning': 'Some of these matched by topic rather than by wording.',
    'search.byMeaning': 'Related',
    'search.byMeaningHint': 'Found because it is about the same topic, not because it matched your words',
    'search.failed': 'Search failed. Please try again.',
    'search.empty': 'Please enter a search term.',
    'files.loadError': 'Could not load the files. Please refresh the page.',
    'files.loadingMine': 'Loading your files...',
    'files.loadingFavorites': 'Loading your favourites...',
    'files.loadingFiles': 'Loading files...',
    'files.noSummary': 'No description/content available to summarize.',
    'files.thinking': 'Thinking...',

    // --- edit-file dialog -------------------------------------------------
    'edit.title': 'Change File',
    'edit.name': 'File Name',
    'edit.description': 'Description:',
    'edit.category': 'Category:',
    'edit.chooseCategory': 'Choose a category',
    'edit.save': 'Change',
    'edit.delete': 'Delete',
    'edit.confirmTitle': 'Confirm Deletion',
    'edit.confirmFile': 'Are you sure you want to delete this file?',
    'edit.confirmFavorite': 'Are you sure you want to remove this from your favourites?',
    'edit.confirmYes': 'Yes, Delete',
    'edit.confirmNo': 'Cancel',
    'edit.noFileOpen': 'No file is open for editing.',

    // --- send-a-message dialog -------------------------------------------
    'msg.title': 'Add Message',
    'msg.chooseReceiver': 'Choose a receiver',
    'msg.content': 'Content...',
    'msg.send': 'Send Message',

    // --- upload page ------------------------------------------------------
    'add.header': 'Add Files',
    'add.chooseCategory': 'Choose a category',
    'add.newCategory': '+ Add a new category...',
    'add.newCategoryPlaceholder': 'New category name (e.g. Organic Chemistry)',
    'add.filename': 'File name',
    'add.describe': 'Describe your file...',
    'add.pdfOnly': 'PDF files only - up to 10 MB.',
    'add.choosePdf': 'Choose a PDF file',
    'add.upload': 'Upload',
    'add.pdfOnlyError': 'Only PDF files can be uploaded.',
    'add.noFile': 'No file selected',
    'add.uploaded': 'Your file was uploaded.',
    'add.openIt': 'Open it',
    'add.categoryLoadError': 'Could not load the category list.',

    // --- messaging --------------------------------------------------------
    'chat.header': 'Messages',
    'chat.searchPeople': 'Search people...',
    'chat.pickSomeone': 'Pick someone from the list to start chatting.',
    'chat.typeMessage': 'Type a message...',
    'chat.noMessages': 'No messages yet - say hello!',
    'chat.sayHello': 'Say hello',
    'chat.noMatch': 'No one matches your search.',
    'chat.pleaseLogin': 'Please log in to view your messages.',
    'chat.loadError': 'Could not load your messages. Please refresh the page.',
    'chat.threadError': 'Could not load that conversation',
    'chat.pickFirst': 'Pick someone from the list first.',
    'chat.tooFast': 'You are sending messages too quickly - wait a moment and try again.',
    'chat.blocked': 'That request was blocked. Reload the page and try again.',
    'chat.sendFailedRefresh': 'Message sent, but the conversation could not be refreshed.',
    'chat.noServer': 'Could not reach the server. Check your connection.',
    'chat.back': 'Back to conversations',

    // --- file viewer ------------------------------------------------------
    'display.favorite': 'Add to favourites',
    'display.comments': 'Comments',
    'display.quiz': 'AI Quiz',
    'display.flashcards': 'AI Flashcards',
    'display.share': 'Copy link',
    'display.commentHistory': 'Comment History',
    'display.commentPlaceholder': 'Type your message...',
    'display.addComment': 'Add Comment',
    'display.noComments': 'No comments yet - be the first.',
    'display.loadingComments': 'Loading comments...',
    'display.commentsError': 'Could not load the comments.',
    'display.commentEmpty': 'Write something before posting.',
    'display.addedFavorite': 'added to favorites',
    'display.linkCopied': 'File path copied!',
    'display.cannotOpen': 'This file cannot be opened',
    'display.noRequest': 'No file was requested',
    'display.noRequestText': 'This page needs a file id in its address, for example /views/Display.html?id=12. Go back to your files and open one from there.',
    'display.missingTitle': 'The upload is missing',
    'display.missingText': 'This file is listed in the database, but the uploaded document is not on the server - so it was most likely never stored successfully. Try uploading it again.',
    'display.noPreviewTitle': 'Preview is not available for this file type',
    'display.noPreviewText': 'Your browser cannot display this kind of file inline. You can download it and open it on your computer.',
    'display.loadingFile': 'Loading the file...',
    'display.download': 'Download the file',
    'display.loadFailedTitle': 'Could not load this file',
    'display.loadFailedText': 'Something went wrong while contacting the server. Check your connection and refresh the page.',
    'display.pleaseLogin': 'Please log in',
    'display.pleaseLoginText': 'Your session has expired. Log in again to open this file.',

    // --- profile ----------------------------------------------------------
    'profile.header': 'Profile Account',
    'profile.name': 'Name',
    'profile.email': 'Email',
    'profile.username': 'Users name',
    'profile.changeHeading': 'Change password',
    'profile.current': 'Current password',
    'profile.new': 'New password',
    'profile.confirm': 'Confirm new password',
    'profile.changeButton': 'Change password',
    'profile.deleteHeading': 'Delete account',
    'profile.deleteWarning': 'This permanently deletes your account and every file, comment, favourite and message attached to it. It cannot be undone.',
    'profile.deleteConfirmField': 'Confirm your password',
    'profile.deleteButton': 'Delete my account permanently',
    'profile.mismatch': 'The two new passwords do not match.',
    'profile.loadError': 'Could not load your profile.',
    'profile.noServer': 'Could not reach the server.',

    // --- AI study buddy ---------------------------------------------------
    'aiTools.quizTitle': 'Quick quiz',
    'aiTools.flashcardsTitle': 'Revision cards',
    'aiTools.generating': 'Generating with AI...',
    'aiTools.flipHint': 'Tap any card to see the answer',
    'aiTools.noQuiz': 'A quiz could not be generated from this file.',
    'aiTools.noCards': 'Revision cards could not be generated from this file.',
    'aiTools.technicalDetails': 'Technical details',
    'aiTools.failed': 'Something went wrong while generating this.',
    'aiTools.offline': 'Could not reach the server.',
    'ai.title': 'AI Study Buddy',
    'ai.subtitle': 'Your personal learning assistant',
    'ai.greeting': "Hello! I'm here to help you study. Upload a note to summarize it, or just ask me anything!",
    'ai.placeholder': 'Type your question...',
  },
  ar: {
    'nav.about': 'عن التطبيق',
    'nav.features': 'المميزات',
    'nav.how': 'كيف يعمل',
    'nav.login': 'تسجيل الدخول',
    'nav.signup': 'إنشاء حساب',

    'hero.eyebrow': 'مدعوم بالذكاء الاصطناعي',
    'hero.titlePrefix': 'ملخصاتك تتحول لـ',
    'hero.titleSuffix': ' بضغطة وحدة',
    'hero.lead': 'ارفع ملفات مذاكرتك، نظّمها بالتصنيفات، وشاركها مع زملائك — والذكاء الاصطناعي يولّد لك أسئلة اختبار وبطاقات مراجعة من نفس المحتوى، ويجاوبك على أسئلتك مباشرة من داخل التطبيق.',
    'hero.cta': 'ابدأ مجانًا',
    'hero.ctaSecondary': 'شوف المميزات',
    'hero.note': 'بياناتك محفوظة عندك، ونستخدم الذكاء الاصطناعي فقط على المحتوى اللي ترفعه بنفسك.',

    'demo.frontTag': 'بطاقة مراجعة تجريبية',
    'demo.frontText': 'وش أسرع طريقة تحول بها ملخص PDF لاختبار؟',
    'demo.frontHint': 'اضغط لعرض الإجابة',
    'demo.backTag': 'الإجابة',
    'demo.backText': 'ارفع الملف بصفحة "For Me" أو "My Files" واضغط زر "اختبار سريع" — الذكاء الاصطناعي يسوّي الباقي.',
    'demo.backHint': 'اضغط للرجوع',
    'demo.caption': 'هذا مثال توضيحي — بطاقاتك الحقيقية تُبنى من ملفاتك أنت',

    'about.heading': 'عن Student Helper',
    'about.subheading': 'منصة مذاكرة تعاونية للطلاب: مكان واحد ترفع فيه ملخصاتك، تلقى فيه ملفات زملائك، وتخلي الذكاء الاصطناعي يساعدك تراجع أسرع وأذكى.',
    'about.copy': 'بدل ما تظل تقلّب بين ملفات متناثرة ومجموعات واتساب، Student Helper يجمع لك كل مصادر المذاكرة بمكان واحد: ارفع، صنّف، وشارك مع اللي تحب. ولما تحتاج تراجع بسرعة قبل اختبار، الذكاء الاصطناعي يبني لك اختبار قصير أو بطاقات مراجعة من نفس الملف — بدون ما تسوي شي يدوي.',
    'about.stat1Title': 'رفع ومشاركة',
    'about.stat1Sub': 'ملفات PDF وصور ومستندات',
    'about.stat2Title': 'ذكاء اصطناعي مدمج',
    'about.stat2Sub': 'اختبارات، بطاقات، وملخصات',
    'about.stat3Title': 'تفاعل بين الطلاب',
    'about.stat3Sub': 'تعليقات ورسائل على كل ملف',

    'features.heading': 'كل اللي تحتاجه عشان تذاكر بذكاء',
    'features.subheading': 'مميزات مبنية حول رحلة الطالب الفعلية: من رفع الملف لين المراجعة النهائية قبل الاختبار.',
    'features.f1Title': 'رفع ملفات سريع',
    'features.f1Text': 'ارفع ملخصاتك بصيغة PDF أو صور أو Word، وصنّفها حسب المادة عشان تلقاها بسهولة بعدين.',
    'features.f2Title': 'اختبار سريع بالذكاء الاصطناعي',
    'features.f2Text': 'حوّل أي ملف PDF لاختبار اختيار من متعدد تلقائي، مبني على نفس محتوى الملف بالضبط.',
    'features.f3Title': 'بطاقات مراجعة',
    'features.f3Text': 'ولّد بطاقات "سؤال وجواب" من ملاحظاتك، وراجعها بسرعة قبل الاختبار من أي جهاز.',
    'features.f4Title': 'مساعد الذكاء الاصطناعي',
    'features.f4Text': 'اسأل مساعد الدراسة أي سؤال، أو خلّه يلخص لك ملف طويل بثواني.',
    'features.f5Title': 'المفضلة والتنظيم',
    'features.f5Text': 'احفظ الملفات المهمة بالمفضلة، وابحث بسرعة بين كل الملفات المتاحة لك.',
    'features.f6Title': 'تعليقات ورسائل',
    'features.f6Text': 'علّق على ملفات زملائك، وأرسل رسائل مباشرة لتنسيق المذاكرة الجماعية.',

    'how.heading': 'يبدأ معك بثلاث خطوات بسيطة',
    'how.subheading': 'ما يحتاج إعداد معقّد — تسجّل، ترفع، وتراجع.',
    'how.s1Title': 'أنشئ حساب',
    'how.s1Text': 'سجّل ببريدك خلال أقل من دقيقة، بدون تعقيد.',
    'how.s2Title': 'ارفع ملفاتك',
    'how.s2Text': 'حمّل ملخصاتك وصنّفها حسب المادة عشان تنظمها من البداية.',
    'how.s3Title': 'راجع بالذكاء الاصطناعي',
    'how.s3Text': 'ولّد اختبار أو بطاقات مراجعة، أو اسأل المساعد مباشرة.',

    'faq.heading': 'أسئلة شائعة',
    'faq.subheading': 'وش يبيلك تعرفه قبل لا تبدأ.',
    'faq.q1': 'هل التطبيق مجاني؟',
    'faq.a1': 'إي، إنشاء الحساب ورفع الملفات واستخدام أدوات الذكاء الاصطناعي كلها متاحة بدون أي رسوم.',
    'faq.q2': 'وش أنواع الملفات اللي أقدر أرفعها؟',
    'faq.a2': 'PDF وصور ومستندات Word وملفات مضغوطة. أدوات الذكاء الاصطناعي (الاختبار والبطاقات) تدعم حاليًا ملفات PDF.',
    'faq.q3': 'هل بياناتي وملفاتي آمنة؟',
    'faq.a3': 'ملفاتك مرتبطة بحسابك فقط، والمحتوى اللي ترفعه يُستخدم مع الذكاء الاصطناعي فقط عشان يولّد لك الاختبارات والبطاقات وملخصاتك أنت - تقدر تراجع التفاصيل كاملة في سياسة الخصوصية.',
    'faq.q4': 'وش الفرق بين "اختبار سريع" و"بطاقات المراجعة"؟',
    'faq.a4': '"اختبار سريع" يولّد أسئلة اختيار من متعدد تختبر فهمك، و"بطاقات المراجعة" تعطيك بطاقات سؤال وجواب قصيرة تراجعها بسرعة - الاثنين يُبنون من نفس محتوى ملفك.',

    'cta.heading': 'جاهز تبدأ تذاكر بذكاء؟',
    'cta.subheading': 'الحساب مجاني، والبداية أسرع من ما تتوقع.',
    'cta.button': 'إنشاء حساب مجاني',

    'footer.privacy': 'سياسة الخصوصية',
    'footer.terms': 'شروط الاستخدام',

    'login.header': 'تسجيل دخول المستخدم',
    'login.username': 'اسم المستخدم',
    'login.password': 'كلمة المرور',
    'login.button': 'تسجيل الدخول',
    'login.or': 'أو',
    'login.google': 'تسجيل الدخول بحساب جوجل',
    'login.createAccount': 'إنشاء حساب',

    'create.header': 'إنشاء حساب',
    'create.name': 'الاسم',
    'create.email': 'البريد الإلكتروني',
    'create.username': 'اسم المستخدم',
    'create.password': 'كلمة المرور',
    'create.termsPrefix': 'أوافق على',
    'create.termsAnd': 'و',
    'create.button': 'إنشاء',

    'dashboard.searchPlaceholder': 'اكتب للبحث...',
    'dashboard.recommended': 'مقترح لك',

    // --- شريط التنقل ------------------------------------------------------
    'nav.account': 'حسابي',
    'nav.messages': 'الرسائل',
    'nav.aiBuddy': 'مساعد الدراسة',
    'nav.addFile': 'إضافة ملف',
    'nav.files': 'الملفات',
    'nav.favorites': 'المفضلة',
    'nav.logout': 'تسجيل الخروج',
    'nav.logoutConfirm': 'تسجيل الخروج من Student Helper؟',
    'nav.search': 'بحث',

    // --- عام --------------------------------------------------------------
    'common.searchPlaceholder': 'اكتب للبحث...',
    'common.loading': 'جاري التحميل...',
    'common.open': 'فتح',
    'common.chat': 'مراسلة',
    'common.details': 'التفاصيل',
    'common.back': 'رجوع',
    'common.uploadedBy': 'رفعه:',
    'common.noDescription': 'ما فيه وصف لهذا الملف.',
    'common.refresh': 'حدّث الصفحة من فضلك.',
    'common.sessionExpired': 'انتهت الجلسة. سجّل الدخول مرة ثانية.',

    // --- قوائم الملفات ----------------------------------------------------
    'files.forMe': 'ملفات لي',
    'files.myFiles': 'ملفاتي',
    'files.summarize': 'تلخيص',
    'files.aiSummary': 'ملخص الذكاء الاصطناعي',
    'files.addFavorite': 'إضافة للمفضلة',
    'files.removeFavorite': 'إزالة من المفضلة',
    'files.addedFavorite': 'تمت الإضافة للمفضلة',
    'files.removedFavorite': 'تمت الإزالة من المفضلة',
    'files.edit': 'تعديل الملف',
    'files.emptyForMe': 'ما فيه ملفات متاحة لك حاليًا.',
    'files.emptyMine': 'ما رفعت أي ملف بعد — ابدأ برفع أول ملف لك.',
    'files.emptyFavorites': 'ما ضفت أي ملف للمفضلة بعد.',
    'files.emptySearch': 'ما فيه ملفات تطابق بحثك.',
    'search.searching': 'جاري البحث...',
    'search.resultsFor': 'نتيجة لـ',
    'search.resultFor': 'نتيجة لـ',
    'search.noResultsFor': 'ما فيه نتائج لـ',
    'search.approximate': 'ما فيه تطابق تام - هذي أقرب الملفات.',
    'search.related': 'يشمل الكلمات المشابهة والمقابل بالعربي والإنجليزي.',
    'search.someByMeaning': 'بعض النتائج طابقت الموضوع مو نص الكلمات.',
    'search.byMeaning': 'مرتبط',
    'search.byMeaningHint': 'ظهر لأن موضوعه نفس اللي تبحث عنه، مو لأنه طابق كلماتك',
    'search.failed': 'فشل البحث. حاول مرة ثانية.',
    'search.empty': 'اكتب كلمة للبحث.',
    'files.loadError': 'تعذّر تحميل الملفات. حدّث الصفحة من فضلك.',
    'files.loadingMine': 'جاري تحميل ملفاتك...',
    'files.loadingFavorites': 'جاري تحميل المفضلة...',
    'files.loadingFiles': 'جاري تحميل الملفات...',
    'files.noSummary': 'ما فيه وصف أو محتوى نقدر نلخصه.',
    'files.thinking': 'جاري التفكير...',

    // --- نافذة تعديل الملف ------------------------------------------------
    'edit.title': 'تعديل الملف',
    'edit.name': 'اسم الملف',
    'edit.description': 'الوصف:',
    'edit.category': 'التصنيف:',
    'edit.chooseCategory': 'اختر تصنيفًا',
    'edit.save': 'حفظ التعديل',
    'edit.delete': 'حذف',
    'edit.confirmTitle': 'تأكيد الحذف',
    'edit.confirmFile': 'متأكد أنك تبي تحذف هذا الملف؟',
    'edit.confirmFavorite': 'متأكد أنك تبي تشيل هذا الملف من المفضلة؟',
    'edit.confirmYes': 'نعم، احذف',
    'edit.confirmNo': 'إلغاء',
    'edit.noFileOpen': 'ما فيه ملف مفتوح للتعديل.',

    // --- نافذة إرسال رسالة -------------------------------------------------
    'msg.title': 'إرسال رسالة',
    'msg.chooseReceiver': 'اختر المستلم',
    'msg.content': 'نص الرسالة...',
    'msg.send': 'إرسال',

    // --- صفحة رفع الملفات --------------------------------------------------
    'add.header': 'إضافة ملفات',
    'add.chooseCategory': 'اختر تصنيفًا',
    'add.newCategory': '+ إضافة تصنيف جديد...',
    'add.newCategoryPlaceholder': 'اسم التصنيف الجديد (مثال: كيمياء عضوية)',
    'add.filename': 'اسم الملف',
    'add.describe': 'اكتب وصفًا للملف...',
    'add.pdfOnly': 'ملفات PDF فقط — بحد أقصى ١٠ ميجابايت.',
    'add.choosePdf': 'اختر ملف PDF',
    'add.upload': 'رفع الملف',
    'add.pdfOnlyError': 'يُسمح برفع ملفات PDF فقط.',
    'add.noFile': 'ما تم اختيار ملف',
    'add.uploaded': 'تم رفع ملفك.',
    'add.openIt': 'افتحه',
    'add.categoryLoadError': 'تعذّر تحميل قائمة التصنيفات.',

    // --- الرسائل ----------------------------------------------------------
    'chat.header': 'الرسائل',
    'chat.searchPeople': 'ابحث عن شخص...',
    'chat.pickSomeone': 'اختر شخصًا من القائمة عشان تبدأ المحادثة.',
    'chat.typeMessage': 'اكتب رسالة...',
    'chat.noMessages': 'ما فيه رسائل بعد — سلّم عليه!',
    'chat.sayHello': 'سلّم عليه',
    'chat.noMatch': 'ما فيه أحد يطابق بحثك.',
    'chat.pleaseLogin': 'سجّل الدخول عشان تشوف رسائلك.',
    'chat.loadError': 'تعذّر تحميل رسائلك. حدّث الصفحة من فضلك.',
    'chat.threadError': 'تعذّر تحميل هذه المحادثة',
    'chat.pickFirst': 'اختر شخصًا من القائمة أولًا.',
    'chat.tooFast': 'ترسل رسائل بسرعة كبيرة — انتظر شوي وحاول مرة ثانية.',
    'chat.blocked': 'تم رفض الطلب. أعد تحميل الصفحة وحاول مرة ثانية.',
    'chat.sendFailedRefresh': 'انرسلت الرسالة، بس ما قدرنا نحدّث المحادثة.',
    'chat.noServer': 'ما قدرنا نوصل للخادم. تحقق من اتصالك.',
    'chat.back': 'رجوع للمحادثات',

    // --- عارض الملفات ------------------------------------------------------
    'display.favorite': 'إضافة للمفضلة',
    'display.comments': 'التعليقات',
    'display.quiz': 'اختبار سريع',
    'display.flashcards': 'بطاقات مراجعة',
    'display.share': 'نسخ الرابط',
    'display.commentHistory': 'التعليقات',
    'display.commentPlaceholder': 'اكتب تعليقك...',
    'display.addComment': 'أضف تعليق',
    'display.noComments': 'ما فيه تعليقات بعد — كن أول واحد.',
    'display.loadingComments': 'جاري تحميل التعليقات...',
    'display.commentsError': 'تعذّر تحميل التعليقات.',
    'display.commentEmpty': 'اكتب شيئًا قبل النشر.',
    'display.addedFavorite': 'تمت الإضافة للمفضلة',
    'display.linkCopied': 'تم نسخ رابط الملف!',
    'display.cannotOpen': 'ما نقدر نفتح هذا الملف',
    'display.noRequest': 'ما تم تحديد ملف',
    'display.noRequestText': 'هذه الصفحة تحتاج رقم الملف في العنوان، مثل /views/Display.html?id=12. ارجع لصفحة ملفاتك وافتح الملف من هناك.',
    'display.missingTitle': 'الملف المرفوع مفقود',
    'display.missingText': 'الملف مسجّل في قاعدة البيانات، لكن الملف نفسه مو موجود على الخادم — غالبًا ما تم حفظه بنجاح. جرّب ترفعه مرة ثانية.',
    'display.noPreviewTitle': 'المعاينة غير متاحة لهذا النوع',
    'display.noPreviewText': 'متصفحك ما يقدر يعرض هذا النوع داخل الصفحة. تقدر تنزّله وتفتحه على جهازك.',
    'display.loadingFile': 'جاري تحميل الملف...',
    'display.download': 'تنزيل الملف',
    'display.loadFailedTitle': 'تعذّر تحميل هذا الملف',
    'display.loadFailedText': 'صار خطأ أثناء الاتصال بالخادم. تحقق من اتصالك وحدّث الصفحة.',
    'display.pleaseLogin': 'سجّل الدخول',
    'display.pleaseLoginText': 'انتهت الجلسة. سجّل الدخول مرة ثانية عشان تفتح الملف.',

    // --- الملف الشخصي ------------------------------------------------------
    'profile.header': 'الملف الشخصي',
    'profile.name': 'الاسم',
    'profile.email': 'البريد الإلكتروني',
    'profile.username': 'اسم المستخدم',
    'profile.changeHeading': 'تغيير كلمة المرور',
    'profile.current': 'كلمة المرور الحالية',
    'profile.new': 'كلمة المرور الجديدة',
    'profile.confirm': 'تأكيد كلمة المرور الجديدة',
    'profile.changeButton': 'تغيير كلمة المرور',
    'profile.deleteHeading': 'حذف الحساب',
    'profile.deleteWarning': 'هذا يحذف حسابك نهائيًا مع كل ملف وتعليق ومفضلة ورسالة مرتبطة فيه. ما يمكن التراجع عنه.',
    'profile.deleteConfirmField': 'أكّد كلمة المرور',
    'profile.deleteButton': 'احذف حسابي نهائيًا',
    'profile.mismatch': 'كلمتا المرور الجديدتان غير متطابقتين.',
    'profile.loadError': 'تعذّر تحميل ملفك الشخصي.',
    'profile.noServer': 'ما قدرنا نوصل للخادم.',

    // --- مساعد الدراسة -----------------------------------------------------
    'aiTools.quizTitle': 'اختبار سريع',
    'aiTools.flashcardsTitle': 'بطاقات المراجعة',
    'aiTools.generating': 'جاري التوليد بالذكاء الاصطناعي...',
    'aiTools.flipHint': 'اضغط على أي بطاقة لعرض الإجابة',
    'aiTools.noQuiz': 'تعذّر توليد اختبار من هذا الملف.',
    'aiTools.noCards': 'تعذّر توليد بطاقات مراجعة من هذا الملف.',
    'aiTools.technicalDetails': 'التفاصيل التقنية',
    'aiTools.failed': 'صار خطأ أثناء التوليد.',
    'aiTools.offline': 'تعذّر الاتصال بالخادم.',
    'ai.title': 'مساعد الدراسة',
    'ai.subtitle': 'مساعدك الشخصي في المذاكرة',
    'ai.greeting': 'هلا! أنا هنا أساعدك في مذاكرتك. ارفع ملخص عشان ألخصه لك، أو اسألني أي شيء!',
    'ai.placeholder': 'اكتب سؤالك...',
  },
};

function shGetLang() {
  try {
    return localStorage.getItem(SH_I18N_STORAGE_KEY);
  } catch (e) {
    return null;
  }
}

function shSetLangPreference(lang) {
  try {
    localStorage.setItem(SH_I18N_STORAGE_KEY, lang);
  } catch (e) {
    // Private-browsing / storage disabled - the toggle still works for the
    // current page view, it just won't be remembered on the next page.
  }
}

/**
 * Look up a string in the active language.
 * Exposed as window.t so the scripts that build UI at runtime (fileCard.js,
 * chat.js, displayChat.js, nav.js and the inline page scripts) can translate
 * the text they generate. `fallback` is what you get if the key is unknown or
 * this file has not loaded yet, so a missing translation degrades to English
 * rather than to a blank element.
 */
function t(key, fallback) {
  const lang = document.documentElement.getAttribute('lang') === 'ar' ? 'ar' : 'en';
  const dict = SH_TRANSLATIONS[lang] || SH_TRANSLATIONS.en;
  if (dict[key] !== undefined) return dict[key];
  if (SH_TRANSLATIONS.en[key] !== undefined) return SH_TRANSLATIONS.en[key];
  return fallback !== undefined ? fallback : key;
}

function applyLang(lang) {
  const normalized = lang === 'ar' ? 'ar' : 'en';
  const dict = SH_TRANSLATIONS[normalized];

  document.documentElement.setAttribute('lang', normalized);
  document.documentElement.setAttribute('dir', normalized === 'ar' ? 'rtl' : 'ltr');

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (dict[key] !== undefined) {
      el.textContent = dict[key];
    }
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (dict[key] !== undefined) {
      el.setAttribute('placeholder', dict[key]);
    }
  });

  // Icon-only controls carry their meaning in a tooltip and an accessible
  // name rather than in visible text, so those need translating too -
  // otherwise the whole navigation bar and the file-viewer toolbar stay
  // English for a screen-reader user even in Arabic.
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (dict[key] !== undefined) el.setAttribute('title', dict[key]);
  });

  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    if (dict[key] !== undefined) el.setAttribute('aria-label', dict[key]);
  });

  document.querySelectorAll('.lang-toggle-btn').forEach((btn) => {
    // Button shows the language you would SWITCH TO.
    btn.textContent = normalized === 'ar' ? 'EN' : 'عربي';
    btn.setAttribute(
      'aria-label',
      normalized === 'ar' ? 'Switch to English' : 'التبديل إلى العربية'
    );
  });

  // Anything rendered by JavaScript (file cards, the conversation list, an
  // open thread) has to be rebuilt - its text was produced by t() at the
  // moment it was created and will not update on its own.
  window.dispatchEvent(new CustomEvent('sh:langchange', { detail: { lang: normalized } }));
}

function toggleLang() {
  const current = document.documentElement.getAttribute('lang') === 'ar' ? 'ar' : 'en';
  const next = current === 'ar' ? 'en' : 'ar';
  shSetLangPreference(next);
  applyLang(next);
}

function shInitLang() {
  const saved = shGetLang();
  const pageDefault = document.documentElement.getAttribute('data-i18n-default') || 'en';
  applyLang(saved || pageDefault);
}

/**
 * Build the language switch and pin it to the top of the page.
 *
 * It used to be a per-page button: four pages hand-rolled their own
 * absolutely-positioned copy (each with the same twelve inline styles), and
 * the app pages got one inside the navigation bar - so the control sat in a
 * different place depending on where you were, and the pages with no navbar
 * had none at all. One control, built here, appears in the same place on
 * every page including the splash and login screens.
 *
 * It is positioned with `inset-inline-start`, so it sits top-right in English
 * and top-left in Arabic - the top OUTER corner either way.
 */
function shMountLangSwitch() {
  if (document.getElementById('sh-lang-switch')) return;
  if (!document.body) return;

  const bar = document.createElement('div');
  bar.className = 'sh-lang-bar';

  const button = document.createElement('button');
  button.type = 'button';
  // .lang-toggle-btn is the hook applyLang() uses to keep the label in sync.
  button.className = 'lang-toggle-btn';
  button.id = 'sh-lang-switch';
  button.addEventListener('click', toggleLang);

  bar.appendChild(button);
  document.body.appendChild(bar);

  // Give it its label immediately, rather than waiting for the next switch.
  applyLang(document.documentElement.getAttribute('lang') === 'ar' ? 'ar' : 'en');
}

// Exposed for the rest of the app: t() to translate a runtime string,
// applyLang() to re-apply after injecting markup, toggleLang() for the button.
window.t = t;
window.applyLang = applyLang;
window.toggleLang = toggleLang;
window.shCurrentLang = () =>
  (document.documentElement.getAttribute('lang') === 'ar' ? 'ar' : 'en');

// Set <html lang/dir> as early as possible - before first paint where the
// script is in <head> - so an Arabic reader does not see the page render
// left-to-right and then jump.
window.shMountLangSwitch = shMountLangSwitch;

shInitLang();

if (document.readyState === 'loading') {
  // Re-run once the body exists, to translate the elements that were not in
  // the DOM yet on the first pass, and to mount the switch.
  document.addEventListener('DOMContentLoaded', () => {
    shInitLang();
    shMountLangSwitch();
  });
} else {
  shMountLangSwitch();
}
