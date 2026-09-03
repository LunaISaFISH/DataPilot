# ADR 0001: AI cannot execute code

Accepted.

Semantic models may return strict, evidence-linked proposals using an allowlisted action name.
They have no dataframe, filesystem, database, network, Python, SQL, or executor access.
Backend grounding validation recomputes affected scope before policy evaluation.

