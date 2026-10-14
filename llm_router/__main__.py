import sys
if len(sys.argv) > 1 and sys.argv[1] in ('feedback', 'stats'):
    from .learning import main
else:
    from .cli import main
    if len(sys.argv) > 1 and sys.argv[1] == 'route':
        sys.argv[1] = '--dry-run'
raise SystemExit(main())
