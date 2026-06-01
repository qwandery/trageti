# v0.2 to v0.3 Migration Note

This guide is intentionally obsolete for the current v0.3 beta track.

During the 2026-06-01 remediation pass, the pre-beta v0.3 migration chain was
flattened to a single baseline schema at version `1`. There are no known
consuming applications or projects on v0.2.x or earlier, so automatic migration
from prototype `trl_` databases is not part of the supported v0.3 contract.

For v0.3 beta testing, rebuild databases from source episode/assertion data
against the baseline `trageti_` schema. If a real pre-v0.3 consumer appears
before release, add a purpose-built importer or one-off migration tool outside
the package's baseline migration path.
